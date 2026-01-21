// noinspection SpellCheckingInspection

import { DateTime } from "luxon";
import { publishCommandAndFanOut } from "./publisher-service";
import { IUser, UserModel } from "../models/user";
import { UserCommandModel } from "../models/user-command";
import {
    TypeUserCommandEnum,
    TypeUserCommandScopeEnum,
    TypeUserStatusEnum
} from "../types";
import BarModel, { IBar, IOpenHourBar } from "../models/bar";

type OpenHour = IOpenHourBar;

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function dayToWeekday(day: string): number {
    switch (day.toLowerCase()) {
        case "monday": return 1;
        case "tuesday": return 2;
        case "wednesday": return 3;
        case "thursday": return 4;
        case "friday": return 5;
        case "saturday": return 6;
        case "sunday": return 7;
        default: return 0;
    }
}

function parseHHMM(hourMinute: string): { hour: number; minute: number } {
    const [h, m] = hourMinute.split(":").map((x) => parseInt(x, 10));
    return { hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 };
}

type BarWindow = {
    openLocal: DateTime;
    closeLocal: DateTime;
};

/**
 * Assembles the relevant windows (open->close) around "now," with timezone applied,
 * including overnight periods (close <= open => close on the following day).
 *
 * Note: we use [-1, 0, +1] days to cover:
 * - overnight windows that start yesterday and end today
 * - the next window that starts tomorrow (to correctly derive the closed period)
 */
function buildWindows(now: Date, timezone: string, openHours: OpenHour[]): { nowLocal: DateTime; windows: BarWindow[] } {
    const tz = timezone || "Europe/Copenhagen";
    const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz);

    const days = [
        nowLocal.minus({ days: 1 }),
        nowLocal,
        nowLocal.plus({ days: 1 }),
    ];

    const windows: BarWindow[] = [];

    for (const baseDay of days) {
        const weekday = baseDay.weekday; // 1..7

        const todays = openHours.filter((h) => {
            const type = String(h?.type || "").toLowerCase();
            const day = String(h?.day || "").toLowerCase();
            return type === "regular" && dayToWeekday(day) === weekday;
        });

        for (const h of todays) {
            if (!h?.open || !h?.close) continue;
            if (h.open === h.close) continue; // current rule: 00:00/00:00 => ignore

            const o = parseHHMM(h.open);
            const c = parseHHMM(h.close);

            const openLocal = baseDay.set({ hour: o.hour, minute: o.minute, second: 0, millisecond: 0 });
            let closeLocal = baseDay.set({ hour: c.hour, minute: c.minute, second: 0, millisecond: 0 });

            // overnight
            if (closeLocal <= openLocal) closeLocal = closeLocal.plus({ days: 1 });

            windows.push({ openLocal, closeLocal });
        }
    }

    windows.sort((a, b) => a.openLocal.toMillis() - b.openLocal.toMillis());

    return { nowLocal, windows };
}

/**
 * Returns:
 * - shouldBeOpen: whether it is currently within an open->close window
 * - openWindowKey: unique key (UTC ISO) of the START of the window in which it is open (if it is)
 * - closeWindowKey: unique key (UTC ISO) of the END of the last window that closed before now (if it is closed)
 *
 * These keys allow you to ensure "execute only once per window".
 */
function getBarOpenStateWithWindowKey(
    now: Date,
    timezone: string,
    openHours: OpenHour[]
): {
    shouldBeOpen: boolean;
    openWindowKey?: string | null;
    closeWindowKey?: string | null;
} {
    const { nowLocal, windows } = buildWindows(now, timezone, openHours);

    // Is it inside any open window?
    for (const w of windows) {
        if (nowLocal >= w.openLocal && nowLocal < w.closeLocal) {
            return {
                shouldBeOpen: true,
                openWindowKey: w.closeLocal.toUTC().toISO(),
            };
        }
    }

    // It's closed: it ties the closed period to the last closing that occurred.
    let lastClosed: BarWindow | undefined;
    for (const w of windows) {
        if (w.closeLocal <= nowLocal) lastClosed = w;
        else break;
    }

    if (lastClosed) {
        return {
            shouldBeOpen: false,
            closeWindowKey: lastClosed.closeLocal.toUTC().toISO(),
        };
    }

    // Extreme case: there is no recent closing price available.
    return {
        shouldBeOpen: false,
        closeWindowKey: `no-prev-close:${nowLocal.startOf("day").toUTC().toISODate()}`
    };
}

async function getUsersToNotify(barId: string): Promise<IUser[]> {
    return UserModel.find({ bar_id: barId, status: TypeUserStatusEnum.ACTIVE });
}

export async function runBarOpenCloseTick(): Promise<{ ok: true; changed: number; scanned: number }> {
    const now = new Date();
    console.log("[BarService].runBarOpenCloseTick(): ISO date", now.toISOString());

    const cursor = BarModel.find(
        { "status.active": true, hidden: false },
        {
            _id: 1,
            name: 1,
            timezone: 1,
            open_hours: 1,
            "status.open_for_orders": 1,
            "status.auto_open_window": 1,
            "status.auto_close_window": 1,
        }
    ).lean<IBar>().cursor();

    let scanned = 0;
    let changed = 0;

    for await (const bar of cursor) {
        console.log("[BarService].runBarOpenCloseTick(): checking bar", bar._id?.toString(), bar.name);

        scanned++;

        const timezone = bar.timezone || "Europe/Copenhagen";
        const openHours: OpenHour[] = Array.isArray(bar.open_hours) ? bar.open_hours : [];

        const { shouldBeOpen, openWindowKey, closeWindowKey } =
            getBarOpenStateWithWindowKey(now, timezone, openHours);

        const currentOpen = !!bar.status?.open_for_orders;

        console.log("[BarService].runBarOpenCloseTick(): bar should be open", shouldBeOpen);

        // If they are the same, maintain current behavior (do nothing)
        if (shouldBeOpen) {
            if (!openWindowKey)
                continue;

            const storedOpenWindow = bar.status?.auto_open_window;

            const alreadyProcessedThisOpenWindow = storedOpenWindow === openWindowKey;

            if (alreadyProcessedThisOpenWindow) {
                console.log("[BarService].runBarOpenCloseTick(): open window already processed, ignoring", {
                    barId: String(bar._id),
                    openWindowKey,
                    storedOpenWindow
                });

                continue;
            }
        } else {
            if (!closeWindowKey)
                continue;

            const alreadyProcessedThisCloseWindow = bar.status?.auto_close_window === closeWindowKey;

            if (alreadyProcessedThisCloseWindow) {
                console.log("[BarService].runBarOpenCloseTick(): close window already processed, ignoring", {
                    barId: String(bar._id),
                    closeWindowKey
                });
                continue;
            }
        }


        // Atomic update with "guard rails":
        // - ensures that it is still in the expected current state (optimistic lock)
        // - ensures that the window key has not already been marked (cross-run idempotency)
        const filter: any = {
            _id: bar._id,
            "status.open_for_orders": currentOpen,
        };

        const set: any = {
            "status.open_for_orders": shouldBeOpen,
            updated_at: now,
        };

        if (shouldBeOpen) {
            // Prevents reopening if it has already been processed with the new key (end) OR with the old key (beginning)
            const denyKeys = [openWindowKey].filter(Boolean);

            filter["status.auto_open_window"] = denyKeys.length > 0
                ? { $nin: denyKeys }
                : { $ne: openWindowKey };

            // Always save the new key (end of the window), which is more stable.
            set["status.auto_open_window"] = openWindowKey;
        } else {
            filter["status.auto_close_window"] = { $ne: closeWindowKey };
            set["status.auto_close_window"] = closeWindowKey;
        }

        const res = await BarModel.updateOne(filter, { $set: set });

        console.log("[BarService].runBarOpenCloseTick(): modified count", res.modifiedCount);

        if (res.modifiedCount !== 1) continue;

        changed++;

        const users = await getUsersToNotify(String(bar._id));
        const batches = chunk(users, 15);

        console.log("[BarService].runBarOpenCloseTick(): total users to publish command", users.length);

        for (const batch of batches) {
            await Promise.all(
                batch.map(async (user: any) => {
                    console.log("[BarService].runBarOpenCloseTick(): user", user._id?.toString(), user.username);

                    const created = await new UserCommandModel({
                        user_id: user._id,
                        username: user.username,
                        scope: TypeUserCommandScopeEnum.USER,
                        command: TypeUserCommandEnum.BAR_OPEN_CLOSED,
                        executed: false,
                    }).save();

                    await publishCommandAndFanOut({
                        _id: String(created._id),
                        user_id: String(created.user_id),
                        username: created.username,
                        scope: created.scope,
                        command: created.command,
                        executed: created.executed,
                        created_at: created.created_at,
                    });
                })
            );
        }

        console.log("[BarService].runBarOpenCloseTick(): updated", {
            barId: String(bar._id),
            open_for_orders: shouldBeOpen,
            notifiedUsers: users.length,
            windowKey: shouldBeOpen ? openWindowKey : closeWindowKey,
        });
    }

    return { ok: true, changed, scanned };
}

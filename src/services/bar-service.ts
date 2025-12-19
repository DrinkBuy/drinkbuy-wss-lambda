// noinspection SpellCheckingInspection

import { DateTime } from "luxon";
import {publishCommandAndFanOut} from "./publisher-service";
import {IUser, UserModel} from "../models/user";
import {UserCommandModel} from "../models/user-command";
import {TypeUserCommandEnum, TypeUserCommandScopeEnum, TypeUserStatusEnum} from "../types";
import BarModel, {IBar, IOpenHourBar} from "../models/bar";

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

/**
 * Rules:
 * - open = 00:00 and close = 00:00 => closed (ignore)
 * - Overnight: if close <= open, close is on the next day
 * - Checks today and yesterday (to cover "closes at 02:00" after midnight)
 */
export function isBarOpenNow(now: Date, timezone: string, openHours: OpenHour[]): boolean {
    const tz = timezone || "Europe/Copenhagen";
    const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz);

    // Debug
    // console.log("[BarService].isBarOpenNow(): now", { now: now.toISOString(), tz, nowLocal: nowLocal.toISO() });

    const candidates = [nowLocal, nowLocal.minus({ days: 1 })];

    for (const baseDay of candidates) {
        const weekday = baseDay.weekday; // 1..7

        const todays = openHours.filter((h) => {
            const type = String(h?.type || "").toLowerCase();
            const day = String(h?.day || "").toLowerCase();
            return type === "regular" && dayToWeekday(day) === weekday;
        });

        for (const h of todays) {
            if (!h?.open || !h?.close) continue;
            if (h.open === h.close) continue;

            const o = parseHHMM(h.open);
            const c = parseHHMM(h.close);

            const openLocal = baseDay.set({ hour: o.hour, minute: o.minute, second: 0, millisecond: 0 });
            let closeLocal = baseDay.set({ hour: c.hour, minute: c.minute, second: 0, millisecond: 0 });

            if (closeLocal <= openLocal) closeLocal = closeLocal.plus({ days: 1 });

            // Debug
            // console.log("[BarService].isBarOpenNow(): window", {
            //    day: h.day,
            //    type: h.type,
            //    openLocal: openLocal.toISO(),
            //    closeLocal: closeLocal.toISO()
            // });

            if (nowLocal >= openLocal && nowLocal < closeLocal) return true;
        }
    }

    return false;
}


async function getUsersToNotify(barId: string): Promise<IUser[]> {
    return UserModel.find({bar_id: barId, status: TypeUserStatusEnum.ACTIVE});
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
        }
    ).lean<IBar>().cursor();

    let scanned = 0;
    let changed = 0;

    for await (const bar of cursor) {

        console.log("[BarService].runBarOpenCloseTick(): checking bar", bar._id?.toString(), bar.name);

        scanned++;
        const timezone = bar.timezone || "Europe/Copenhagen";
        const openHours: OpenHour[] = Array.isArray(bar.open_hours) ? bar.open_hours : [];
        const shouldBeOpen = isBarOpenNow(now, timezone, openHours);
        const currentOpen = !!bar.status?.open_for_orders;

        console.log("[BarService].runBarOpenCloseTick(): bar should be open", shouldBeOpen);

        if (shouldBeOpen === currentOpen)
            continue;

        const res = await BarModel.updateOne(
            { _id: bar._id, "status.open_for_orders": currentOpen },
            {
                $set: {
                    "status.open_for_orders": shouldBeOpen,
                    updated_at: now,
                },
            }
        );

        console.log("[BarService].runBarOpenCloseTick(): modified count", res.modifiedCount);

        if (res.modifiedCount !== 1)
            continue;

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
        });
    }

    return { ok: true, changed, scanned };
}

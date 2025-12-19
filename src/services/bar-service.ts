// noinspection SpellCheckingInspection

import { DateTime } from "luxon";
import {publishCommandAndFanOut} from "./publisher-service";
import {IUser, UserModel} from "../models/user";
import {UserCommandModel} from "../models/user-command";
import {TypeUserCommandEnum, TypeUserCommandScopeEnum} from "../types";
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
export function isBarOpenNow(nowUtc: Date, timezone: string, openHours: OpenHour[]): boolean {
    const tz = timezone || "UTC";
    const nowLocal = DateTime.fromJSDate(nowUtc, { zone: "utc" }).setZone(tz);

    const candidates = [nowLocal, nowLocal.minus({ days: 1 })];

    for (const baseDay of candidates) {
        // 1..7
        const weekday = baseDay.weekday;
        const todays = openHours.filter(
            (h) => h?.type === "regular" && dayToWeekday(h.day) === weekday
        );

        for (const h of todays) {
            if (h.open === "00:00" && h.close === "00:00")
                continue;

            const o = parseHHMM(h.open);
            const c = parseHHMM(h.close);

            const openLocal = baseDay.set({ hour: o.hour, minute: o.minute, second: 0, millisecond: 0 });
            let closeLocal = baseDay.set({ hour: c.hour, minute: c.minute, second: 0, millisecond: 0 });

            if (closeLocal <= openLocal)
                closeLocal = closeLocal.plus({ days: 1 });

            if (nowLocal >= openLocal && nowLocal < closeLocal)
                return true;
        }
    }

    return false;
}

async function getUsersToNotify(barId: any): Promise<IUser[]> {
    return UserModel.find({bar_id: barId, active: true});
}

export async function runBarOpenCloseTick(): Promise<{ ok: true; changed: number; scanned: number }> {
    const nowUtc = new Date();

    console.log("[BarService].runBarOpenCloseTick(): ISO date", nowUtc.toISOString());

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
        scanned++;
        const timezone = bar.timezone || "Europe/Copenhagen";
        const openHours: OpenHour[] = Array.isArray(bar.open_hours) ? bar.open_hours : [];
        const shouldBeOpen = isBarOpenNow(nowUtc, timezone, openHours);
        const currentOpen = !!bar.status?.open_for_orders;

        if (shouldBeOpen === currentOpen)
            continue;

        const res = await BarModel.updateOne(
            { _id: bar._id, "status.open_for_orders": currentOpen },
            {
                $set: {
                    "status.open_for_orders": shouldBeOpen,
                    updated_at: nowUtc,
                },
            }
        );

        if (res.modifiedCount !== 1)
            continue;

        changed++;

        const users = await getUsersToNotify(bar._id);
        const batches = chunk(users, 15);

        for (const batch of batches) {
            await Promise.all(
                batch.map(async (user: any) => {
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

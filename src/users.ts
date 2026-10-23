// Looking up end users by the caller's own id, always scoped to the caller's account.
import { notFoundError } from "./errors.js";
import { planColumns, planFromRow, planJson, type Db } from "./plans.js";

export const USER_SELECT = `
    SELECT u.id, u.external_user_id, u.created_at, ${planColumns("p", "plan_")}
      FROM users u
      JOIN plans p ON p.id = u.plan_id`;

export function userJson(row: Record<string, any>) {
    return {
        id: row.id,
        externalUserId: row.external_user_id,
        plan: planJson(planFromRow(row, "plan_")),
        createdAt: row.created_at,
    };
}

/** The user row, or a 404. Another account's user with the same id is never returned. */
export async function findUser(db: Db, accountId: string, externalUserId: string) {
    const { rows } = await db.query(
        `${USER_SELECT} WHERE u.account_id = $1 AND u.external_user_id = $2`,
        [accountId, externalUserId],
    );
    const row = rows[0];
    if (!row) {
        throw notFoundError(`user "${externalUserId}" not found`);
    }
    return row;
}

import type { Knex } from "knex";
import { AppError } from "./errors.js";

/**
 * Serializes privileged mutations per company (roadmap: permission mutations
 * and protected writes share this lock). Locks the single company row with
 * SELECT ... FOR UPDATE inside the caller's transaction — concurrent
 * mutations on the same company then serialize on the row lock.
 *
 * Throws AppError(404, "COMPANY_NOT_FOUND") when the id does not exist, e.g. a
 * forged company id from client input — callers must never create the row
 * implicitly.
 */
export async function lockCompany(
  tx: Knex.Transaction,
  companyId: string,
): Promise<void> {
  const row = await tx("company")
    .select("id")
    .where({ id: companyId })
    .forUpdate()
    .first();
  if (!row) {
    throw new AppError(404, "COMPANY_NOT_FOUND", "Không tìm thấy công ty");
  }
}

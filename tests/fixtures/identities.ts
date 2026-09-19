import type { Role } from "../../server/src/shared/contracts.js";

/**
 * Demo identities — the single source of truth for the demo seed
 * (server/src/db/seed-demo.ts) and for tests. Mirrors the 3-level org tree
 * from assets/data.js (PEOPLE + ORG):
 *
 *   l1 (owner, Giám đốc vùng HCM)
 *   ├── p7 (Trưởng PGD Quận 7)            → s1, s2
 *   ├── thn (Tổ trưởng Thu hồi nợ sớm)    → s3, s4
 *   ├── td (Trưởng nhóm Thẩm định TS)     → s5
 *   └── hr (CV Tuyển dụng khối vận hành)
 *
 * Identities only — canvas content is a Phase 2 seed. Credentials are
 * PUBLISHED on purpose (spec §8: demo accounts are public, same auth path,
 * no bypass). demoUserId values are deterministic so a re-seeded demo
 * deployment keeps stable, documentable IDs.
 */
export const DEMO_PASSWORD = "demo-password-2026";

export type DemoId =
  | "l1"
  | "p7"
  | "thn"
  | "td"
  | "hr"
  | "s1"
  | "s2"
  | "s3"
  | "s4"
  | "s5";

export interface DemoIdentity {
  email: string;
  name: string;
  title: string;
  password: string;
  demoUserId: string;
  role: Role;
  /** Demo id of this person's manager in the ORG tree; null for l1. */
  managerDemoId: DemoId | null;
}

// Key order is insertion order and parents precede children, so seeding can
// iterate Object.entries and satisfy the app_user manager FK without a
// second pass.
export const DEMO_IDENTITIES: Record<DemoId, DemoIdentity> = {
  l1: {
    email: "l1@gwp.demo",
    name: "Trần Hải Đăng",
    title: "Giám đốc vùng HCM",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000001",
    role: "owner",
    managerDemoId: null,
  },
  p7: {
    email: "p7@gwp.demo",
    name: "Phạm Thu Hà",
    title: "Trưởng PGD Quận 7",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000002",
    role: "manager",
    managerDemoId: "l1",
  },
  thn: {
    email: "thn@gwp.demo",
    name: "Vũ Quốc Bảo",
    title: "Tổ trưởng Thu hồi nợ sớm",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000003",
    role: "manager",
    managerDemoId: "l1",
  },
  td: {
    email: "td@gwp.demo",
    name: "Hoàng Anh Tuấn",
    title: "Trưởng nhóm Thẩm định tài sản",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000004",
    role: "manager",
    managerDemoId: "l1",
  },
  hr: {
    email: "hr@gwp.demo",
    name: "Mai Khánh Linh",
    title: "Chuyên viên Tuyển dụng khối vận hành",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000005",
    role: "manager",
    managerDemoId: "l1",
  },
  s1: {
    email: "s1@gwp.demo",
    name: "Lê Văn Sơn",
    title: "Chuyên viên tư vấn — PGD Quận 7",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000006",
    role: "member",
    managerDemoId: "p7",
  },
  s2: {
    email: "s2@gwp.demo",
    name: "Đỗ Minh Thư",
    title: "Chuyên viên tư vấn — PGD Quận 7",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000007",
    role: "member",
    managerDemoId: "p7",
  },
  s3: {
    email: "s3@gwp.demo",
    name: "Ngô Thanh Tùng",
    title: "Phó tổ Thu hồi nợ sớm",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000008",
    role: "member",
    managerDemoId: "thn",
  },
  s4: {
    email: "s4@gwp.demo",
    name: "Bùi Hải Yến",
    title: "Nhân viên thu hồi nợ",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-000000000009",
    role: "member",
    managerDemoId: "thn",
  },
  s5: {
    email: "s5@gwp.demo",
    name: "Trịnh Gia Huy",
    title: "Nhân viên thẩm định",
    password: DEMO_PASSWORD,
    demoUserId: "de100000-0000-4000-8000-00000000000a",
    role: "member",
    managerDemoId: "td",
  },
};

export type Id = string;
export type Role = "owner" | "admin" | "manager" | "member";
export type ActorContext = Readonly<{
  userId: Id; companyId: Id; sessionId: Id; requestId: string;
}>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Clock = () => Date;
export type AppErrorBody = {
  code: string; message: string; details?: unknown; request_id: string;
};

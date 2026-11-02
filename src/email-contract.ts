export type EmailPurpose = "signup" | "reset" | "link";
export type EmailInspection =
  | { kind: "signup" | "reset"; email: string }
  | { kind: "link"; email: string; username: string }
  | { kind: "unavailable" };
export type EmailAvailability = "ready" | "unavailable" | "unsupported";

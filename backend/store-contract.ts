import type { Board } from "../src/board.js";
import type { ClassroomStore } from "./classroom-contract.js";
import type { OnboardingStore } from "./onboarding.js";
import type { GoogleStore } from "./google-store.js";

export type Account = {
  id: string;
  username: string;
  passwordHash: string;
  localOnly: boolean;
};
export type Session = { account: Account; expiresAt: number };
export type SavedBoard = { board: Board; revision: number };
// Both adapters use the shared parser: v1 reads migrate in memory; writes use v2.
export interface Store {
  readonly classrooms?: ClassroomStore;
  readonly onboarding?: OnboardingStore;
  readonly google?: GoogleStore;
  account(username: string): Promise<Account | null>;
  session(hash: string, now: number): Promise<Session | null>;
  createSession(
    hash: string,
    accountId: string,
    expiresAt: number,
  ): Promise<void>;
  deleteSession(hash: string): Promise<void>;
  board(accountId: string): Promise<SavedBoard | null>;
  saveBoard(
    accountId: string,
    board: Board,
    revision: number,
  ): Promise<SavedBoard | null>;
  // Read-only preflight; allowLogin still atomically charges the attempt.
  loginAvailable(key: string, now: number): Promise<boolean>;
  allowLogin(key: string, now: number): Promise<boolean>;
}

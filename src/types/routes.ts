import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthState } from "./context.ts";

export type PublicHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => Promise<void> | void;

export type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthState,
  url: URL
) => Promise<void> | void;

export interface PublicRoute {
  method: string;
  path: string;
  handler: PublicHandler;
}

export interface ApiRoute {
  method: string;
  path: string;
  handler: ApiHandler;
}

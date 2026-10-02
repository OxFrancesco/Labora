import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { ComputerError, type PairRequest } from "./contracts";

const Client = Schema.Struct({
  id: Schema.String, name: Schema.String, digest: Schema.String, createdAt: Schema.Number,
  pendingUntil: Schema.optional(Schema.Number),
});

const State = Schema.Struct({ id: Schema.String, clients: Schema.Array(Client) });

type State = typeof State.Type;

export interface PairingCode { code: string; expiresAt: number; attemptsRemaining: number }

export class ComputerAuthority extends Context.Service<ComputerAuthority, {
  computerId: string;
  authenticate: (token: string) => Effect.Effect<string, ComputerError>;
  pair: (request: PairRequest) => Effect.Effect<{ token: string; clientId: string }, ComputerError>;
  grant: (clientName: string, expiresAt: number) => Effect.Effect<{ token: string; clientId: string }, ComputerError>;
  confirmGrant: (clientId: string) => Effect.Effect<void, ComputerError>;
  revoke: (clientId: string) => Effect.Effect<void, ComputerError>;
  issuePairingCode: () => Effect.Effect<PairingCode>;
}>()("labora/ComputerAuthority") {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(digest(left), "hex"), Buffer.from(digest(right), "hex"));

const persistenceError = () => new ComputerError({ status: 500, code: "authority_store", message: "Unable to access computer authorization storage" });

export const authorityLayer = (dataDir: string) => Layer.effect(ComputerAuthority, Effect.gen(function* () {
  const path = join(dataDir, "authority.json");

  let state = yield* Effect.tryPromise({ try: async (): Promise<State> => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dataDir, 0o700);

    try { return Schema.decodeUnknownSync(State)(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const initial: State = { id: crypto.randomUUID(), clients: [] };

      try { await writeFile(path, JSON.stringify(initial), { mode: 0o600, flag: "wx" });

 return initial; }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return Schema.decodeUnknownSync(State)(JSON.parse(await readFile(path, "utf8")));
        throw error;
      }
    }
  }, catch: persistenceError });

  const semaphore = yield* Semaphore.make(1);
  let pairing: PairingCode | undefined;

  const save = Effect.fn("ComputerAuthority.save")((next: State) => Effect.tryPromise({ try: async () => {
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
    await rename(temp, path);
    state = next;
  }, catch: persistenceError }));

  const issueCredential = Effect.fn("ComputerAuthority.issueCredential")(function* (clientName: string, pendingUntil?: number) {
    const token = randomBytes(32).toString("base64url");
    const clientId = crypto.randomUUID();
    const client: typeof Client.Type = { id: clientId, name: clientName, digest: digest(token), createdAt: Date.now(), pendingUntil };
    yield* save({ ...state, clients: [...state.clients.filter((item) => item.pendingUntil === undefined || item.pendingUntil > Date.now()), client] });

    return { token, clientId };
  });

  return ComputerAuthority.of({
    computerId: state.id,
    authenticate: Effect.fn("ComputerAuthority.authenticate")(function* (token: string) {
      if (token.length < 40 || token.length > 256) return yield* Effect.fail(new ComputerError({ status: 401, code: "unauthorized", message: "Pair this client with the computer" }));
      const tokenDigest = digest(token);
      const client = state.clients.find(client => client.pendingUntil === undefined && equal(client.digest, tokenDigest));

      if (!client) return yield* Effect.fail(new ComputerError({ status: 401, code: "unauthorized", message: "The computer credential is invalid or revoked" }));

      return client.id;
    }),
    pair: Effect.fn("ComputerAuthority.pair")((request: PairRequest) => semaphore.withPermit(Effect.gen(function* () {
      if (!pairing || pairing.expiresAt <= Date.now() || pairing.attemptsRemaining <= 0) return yield* Effect.fail(new ComputerError({ status: 403, code: "pairing_expired", message: "Create a new pairing code on the computer" }));
      pairing.attemptsRemaining -= 1;

      if (!equal(pairing.code, request.code)) return yield* Effect.fail(new ComputerError({ status: 403, code: "pairing_invalid", message: "Pairing code is invalid" }));
      pairing = undefined;

      return yield* issueCredential(request.clientName);
    }))),
    grant: Effect.fn("ComputerAuthority.grant")((clientName: string, expiresAt: number) => semaphore.withPermit(issueCredential(clientName, expiresAt))),
    confirmGrant: Effect.fn("ComputerAuthority.confirmGrant")((clientId: string) => semaphore.withPermit(Effect.gen(function* () {
      const client = state.clients.find((item) => item.id === clientId);

      if (!client) return yield* Effect.fail(new ComputerError({ status: 410, code: "enrollment_revoked", message: "This connection was cancelled. Start again in Labora." }));

      if (client.pendingUntil !== undefined && client.pendingUntil <= Date.now()) {
        yield* save({ ...state, clients: state.clients.filter((item) => item.id !== clientId) });

        return yield* Effect.fail(new ComputerError({ status: 410, code: "enrollment_expired", message: "This connection request expired. Start again in Labora." }));
      }

      if (client.pendingUntil === undefined) return;
      yield* save({ ...state, clients: state.clients.map((item) => item.id === clientId
        ? { id: item.id, name: item.name, digest: item.digest, createdAt: item.createdAt }
        : item) });
    }))),
    revoke: Effect.fn("ComputerAuthority.revoke")((clientId: string) => semaphore.withPermit(Effect.suspend(() => save({ ...state, clients: state.clients.filter(client => client.id !== clientId) })))),
    issuePairingCode: Effect.fn("ComputerAuthority.issuePairingCode")(() => Effect.sync(() => {
      pairing = { code: randomInt(0, 100_000_000).toString().padStart(8, "0"), expiresAt: Date.now() + 300_000, attemptsRemaining: 5 };

      return { ...pairing };
    })),
  });
}));

import { afterEach, expect, test } from "bun:test"
import { signInWithAccount, signUpWithAccount } from "./teams-client"

type Win = Omit<Window, "api"> & { api?: unknown }

const win = window as unknown as Win

afterEach(() => {
  delete win.api
})

function desktop(fn: "signIn" | "signUp") {
  const calls: unknown[] = []
  win.api = {
    teams: { list: () => Promise.resolve({ teams: [] }) },
    account: {
      [fn]: () =>
        Promise.resolve({
          status: "ok",
          token: "tok",
          exp: 123,
          customer_id: "cid",
        }),
      writeSession: (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve()
      },
    },
  }
  return calls
}

test("signInWithAccount normalizes desktop ok sessions", async () => {
  const calls = desktop("signIn")
  const res = await signInWithAccount({ username: "user", password: "password" })
  expect(res).toEqual({ status: "approved", token: "tok", exp: 123, customer_id: "cid" })
  expect(calls).toEqual([["tok", "cid", 123]])
})

test("signUpWithAccount normalizes desktop ok sessions", async () => {
  const calls = desktop("signUp")
  const res = await signUpWithAccount({ username: "user", password: "password" })
  expect(res).toEqual({ status: "approved", token: "tok", exp: 123, customer_id: "cid" })
  expect(calls).toEqual([["tok", "cid", 123]])
})

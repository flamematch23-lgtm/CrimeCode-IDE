import { test, expect } from "bun:test"
import { makeTestDbs } from "./helpers"

test("makeTestDbs creates two writable DBs and cleans up", () => {
  const { usage, license, cleanup } = makeTestDbs()
  usage.exec("CREATE TABLE t (x INTEGER);")
  license.exec("CREATE TABLE u (y TEXT);")
  usage.run("INSERT INTO t VALUES (1)")
  license.run("INSERT INTO u VALUES ('hi')")
  expect(usage.query("SELECT x FROM t").get()).toEqual({ x: 1 })
  expect(license.query("SELECT y FROM u").get()).toEqual({ y: "hi" })
  cleanup()
})

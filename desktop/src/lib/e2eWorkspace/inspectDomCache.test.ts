import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInspectDomCache,
  inspectCacheKey,
  isLikelyLoginTestCase,
  isLikelyLoginWallDom,
} from "./inspectDomCache.js";

describe("inspectCacheKey", () => {
  it("differs by featurePath and FE seed", () => {
    const a = inspectCacheKey({
      targetUrl: "http://localhost:9000/",
      featurePath: "/evidence",
      feSeed: "evidence.component.html",
    });
    const b = inspectCacheKey({
      targetUrl: "http://localhost:9000",
      featurePath: "/owners",
      feSeed: "evidence.component.html",
    });
    const c = inspectCacheKey({
      targetUrl: "http://localhost:9000",
      featurePath: "/evidence",
      feSeed: "owners.component.html",
    });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.equal(
      a,
      inspectCacheKey({
        targetUrl: "http://localhost:9000",
        featurePath: "/evidence",
        feSeed: "evidence.component.html",
      })
    );
  });
});

describe("isLikelyLoginWallDom", () => {
  it("detects password / login UI", () => {
    assert.equal(
      isLikelyLoginWallDom('{"elements":[{"type":"password","name":"password"}]}'),
      true
    );
    assert.equal(isLikelyLoginWallDom("button Thêm mới evidence table"), false);
  });
});

describe("isLikelyLoginTestCase", () => {
  it("flags login titles", () => {
    assert.equal(isLikelyLoginTestCase({ title: "Đăng nhập admin" }), true);
    assert.equal(isLikelyLoginTestCase({ title: "Tạo chủ sở hữu" }), false);
  });
});

describe("createInspectDomCache", () => {
  it("dedupes parallel fetch for same key", async () => {
    const cache = createInspectDomCache();
    let fetches = 0;
    const key = inspectCacheKey({
      targetUrl: "http://x",
      featurePath: "/a",
      feSeed: "f.html",
    });
    const fetch = async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        domSnapshot: '{"elements":[{"name":"ok"}]}',
        elementCount: 1,
        routeCount: 0,
        source: "url",
        routes: [] as string[],
      };
    };
    const [r1, r2] = await Promise.all([
      cache.getOrFetch(key, fetch),
      cache.getOrFetch(key, fetch),
    ]);
    assert.equal(fetches, 1);
    assert.equal(r1.fromCache || r2.fromCache, true);
    assert.equal(r1.entry.domSnapshot, r2.entry.domSnapshot);

    const r3 = await cache.getOrFetch(key, fetch);
    assert.equal(r3.fromCache, true);
    assert.equal(fetches, 1);
  });

  it("does not cache login-wall DOM (S3.2)", async () => {
    const cache = createInspectDomCache();
    let fetches = 0;
    const key = inspectCacheKey({
      targetUrl: "http://x",
      featurePath: "/feature",
    });
    const fetchWall = async () => {
      fetches += 1;
      return {
        domSnapshot:
          '{"elements":[{"type":"password","name":"password"},{"name":"Đăng nhập"}]}',
        elementCount: 2,
        routeCount: 0,
        source: "url",
        routes: [] as string[],
        loginWall: true,
      };
    };
    const r1 = await cache.getOrFetch(key, fetchWall);
    assert.equal(r1.fromCache, false);
    assert.equal(r1.entry.loginWall, true);
    assert.equal(cache.size(), 0);
    const r2 = await cache.getOrFetch(key, fetchWall);
    assert.equal(r2.fromCache, false);
    assert.equal(fetches, 2);
  });

  it("still caches non-login feature DOM", async () => {
    const cache = createInspectDomCache();
    let fetches = 0;
    const key = inspectCacheKey({
      targetUrl: "http://x",
      featurePath: "/rooms",
    });
    const fetchOk = async () => {
      fetches += 1;
      return {
        domSnapshot: '{"elements":[{"name":"Thêm mới"}]}',
        elementCount: 1,
        routeCount: 0,
        source: "url",
        routes: [] as string[],
        loginWall: false,
      };
    };
    await cache.getOrFetch(key, fetchOk);
    const hit = await cache.getOrFetch(key, fetchOk);
    assert.equal(hit.fromCache, true);
    assert.equal(fetches, 1);
  });

  it("separate keys fetch separately", async () => {
    const cache = createInspectDomCache();
    let fetches = 0;
    const fetch = async () => {
      fetches += 1;
      return {
        domSnapshot: "{}",
        elementCount: 0,
        routeCount: 0,
        source: "url",
        routes: [] as string[],
      };
    };
    await cache.getOrFetch(
      inspectCacheKey({ targetUrl: "http://x", featurePath: "/a" }),
      fetch
    );
    await cache.getOrFetch(
      inspectCacheKey({ targetUrl: "http://x", featurePath: "/b" }),
      fetch
    );
    assert.equal(fetches, 2);
  });
});

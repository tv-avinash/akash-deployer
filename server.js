// server.js — Akash deployer with durable Upstash Redis queue + notify
import express from "express";
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { Redis } from "@upstash/redis";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- ENV ----
const AKASH_NODE   = process.env.AKASH_NODE   || "https://rpc.akashnet.net:443";
const AKASH_CHAIN  = process.env.AKASH_CHAIN  || "akashnet-2";
const FROM         = process.env.AKASH_FROM   || "tenant";
const MNEMONIC     = process.env.AKASH_MNEMONIC;
const KEYRING_BACK = process.env.KEYRING_BACKEND || "test";
const PROVIDER     = process.env.PROVIDER_ADDR;
const MIN_DEPOSIT  = process.env.MIN_DEPOSIT || "5000000uakt";
const BUSY_CHECK   = process.env.BUSY_CHECK_URL || "";

// Flags
const DRY_RUN            = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const DISABLE_BUSY_CHECK = /^(1|true|yes)$/i.test(process.env.DISABLE_BUSY_CHECK || "");
const ENABLE_QUEUE       = /^(1|true|yes)$/i.test(process.env.ENABLE_QUEUE || "");

// Notify (calls your Next.js /api/notify)
const NOTIFY_URL   = process.env.NOTIFY_URL || "";
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN || "";

// ---- Durable queue via Upstash Redis ----
const QUEUE_KEY = process.env.QUEUE_KEY || "indianode:queue";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const redis = (REDIS_URL && REDIS_TOK) ? new Redis({ url: REDIS_URL, token: REDIS_TOK }) : null;

async function qLen() { return redis ? (await redis.llen(QUEUE_KEY)) : 0; }
async function enqueue(job) {
  if (!redis) throw new Error("queue_not_configured");
  await redis.rpush(QUEUE_KEY, JSON.stringify(job));       // FIFO: push to tail
  return await redis.llen(QUEUE_KEY);
}
async function dequeue() {
  if (!redis) return null;
  const raw = await redis.lpop(QUEUE_KEY);                 // pop from head
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function peekAll(limit = 50) {
  if (!redis) return [];
  const arr = await redis.lrange(QUEUE_KEY, 0, Math.max(0, limit - 1));
  return arr.map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
}
async function clearQueue() {
  if (!redis) return;
  await redis.del(QUEUE_KEY);
}

// ------------------------------------------------------------

function sh(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).toString()));
      resolve(stdout.toString().trim());
    });
  });
}

async function ensureAkashKey() {
  try {
    const addr = await sh("akash", ["keys", "show", FROM, "-a", "--keyring-backend", KEYRING_BACK]);
    return addr.trim();
  } catch {
    if (!MNEMONIC) throw new Error("AKASH_MNEMONIC missing and key not found");
    await sh("bash", ["-lc", `printf "%s" "${MNEMONIC}" | akash keys add ${FROM} --recover --keyring-backend ${KEYRING_BACK}`]);
    const addr = await sh("akash", ["keys", "show", FROM, "-a", "--keyring-backend", KEYRING_BACK]);
    return addr.trim();
  }
}

// Fail-closed: if check errors, treat as busy so queue is preserved
async function gpuAvailable() {
  if (DISABLE_BUSY_CHECK || !BUSY_CHECK) return true;
  try {
    const r = await fetch(BUSY_CHECK, { cache: "no-store" });
    const j = await r.json();
    return j?.status === "available";
  } catch (e) {
    console.error("BUSY_CHECK_ERROR", e?.message || e);
    return false;
  }
}

function sdlFor(product) {
  const file = product === "whisper" ? "whisper.yaml"
             : product === "sd"      ? "stable-diffusion.yaml"
             : product === "llama"   ? "llama.yaml"
             : null;
  if (!file) throw new Error("invalid_product");
  return fs.readFile(path.join("sdl", file), "utf8");
}

const wait = (ms)=>new Promise(r=>setTimeout(r,ms));

async function notifyLive({ email, uri, product, minutes, dry_run }) {
  if (!NOTIFY_URL || !email || !uri) return;
  try {
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Notify-Token": NOTIFY_TOKEN || "",
      },
      body: JSON.stringify({ email, uri, product, minutes, dry_run: !!dry_run }),
    });
  } catch {}
}

// ---- Core run logic (used by API and queue worker) ----
async function runJob({ product, minutes = 60, customer = {}, payment = {} }) {
  if (DRY_RUN) {
    const uri = `https://demo.indianode.com/job/${product}-${Date.now() % 1e6}`;
    console.log("dry_run_accept", { product, minutes, email: customer?.email, uri });
    if (customer?.email) await notifyLive({ email: customer.email, uri, product, minutes, dry_run: true });
    return { status: "ok", uri, dry_run: true };
  }

  if (!PROVIDER) throw new Error("PROVIDER_ADDR not set");

  const owner = await ensureAkashKey();
  const dseq  = String(Math.floor(Date.now() / 1000));
  const sdl   = (await sdlFor(product)).replace(/PROVIDER_ADDR_REPLACE_ME/g, PROVIDER);
  const sdlPath = `/tmp/${dseq}.yaml`;
  await fs.writeFile(sdlPath, sdl);

  // 1) create deployment
  await sh("akash", [
    "tx","deployment","create", sdlPath,
    "--from", FROM, "--keyring-backend", KEYRING_BACK,
    "--node", AKASH_NODE, "--chain-id", AKASH_CHAIN,
    "--deposit", MIN_DEPOSIT, "--yes"
  ]);

  // 2) wait for lease from our provider
  let lease = null;
  for (let i=0;i<30;i++){
    const out = await sh("akash", [
      "query","market","lease","list",
      "--owner", owner, "--dseq", dseq,
      "--node", AKASH_NODE, "--output","json"
    ]).catch(()=> "");
    try {
      const j = JSON.parse(out);
      lease = (j.leases || []).map(x => x.lease?.id).find(id => id?.provider === PROVIDER);
      if (lease) break;
    } catch {}
    await wait(4000);
  }
  if (!lease) throw new Error("no_lease_from_provider");

  const { gseq, oseq, provider } = lease;

  // 3) send manifest
  await sh("akash", [
    "provider","send-manifest", sdlPath,
    "--node", AKASH_NODE,
    "--dseq", dseq, "--gseq", String(gseq), "--oseq", String(oseq),
    "--owner", owner, "--provider", provider
  ]);

  // 4) poll for URI
  let uri = "";
  for (let i=0;i<45;i++){
    const out = await sh("akash", [
      "provider","lease-status",
      "--node", AKASH_NODE,
      "--dseq", dseq, "--gseq", String(gseq), "--oseq", String(oseq),
      "--owner", owner, "--provider", provider, "--output","json"
    ]).catch(()=> "");
    try {
      const j = JSON.parse(out);
      const svc = Object.values(j?.services || {})[0];
      if (svc?.uris?.length) { uri = svc.uris[0]; break; }
    } catch {}
    await wait(4000);
  }
  if (!uri) console.warn("no_uri_yet");

  // 5) notify user if email present
  if (uri && customer?.email) {
    await notifyLive({ email: customer.email, uri, product, minutes, dry_run: false });
  }

  // 6) auto-close later
  setTimeout(async () => {
    try {
      await sh("akash", [
        "tx","deployment","close",
        "--owner", owner, "--dseq", dseq,
        "--from", FROM, "--keyring-backend", KEYRING_BACK,
        "--node", AKASH_NODE, "--chain-id", AKASH_CHAIN, "--yes"
      ]);
      console.log("closed_deployment", { dseq });
    } catch (e) { console.error("close_failed", e.message); }
  }, Math.max(1, Number(minutes)) * 60 * 1000);

  return { status: "ok", uri, dseq, gseq, oseq, provider };
}

// ---- Info/admin endpoints ----
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

app.get("/__info", async (req,res) => {
  const len = await qLen().catch(()=>0);
  res.json({
    dry_run: DRY_RUN,
    disable_busy_check: DISABLE_BUSY_CHECK,
    busy_check_url: !!BUSY_CHECK,
    enable_queue: ENABLE_QUEUE,
    queue_len: len,
    queue_store: redis ? "upstash" : "none"
  });
});

app.get("/admin/queue", async (req,res) => {
  const items = await peekAll(50).catch(()=>[]);
  res.json({ queue: items });
});

app.post("/admin/queue/clear", async (req,res) => {
  const t = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  await clearQueue();
  res.json({ ok: true });
});

// ---- API: submit job ----
app.post("/", async (req, res) => {
  const idem = req.headers["idempotency-key"];
  const { product, minutes = 60, customer = {}, payment = {} } = req.body || {};

  const ALLOWED = new Set(["whisper", "sd", "llama"]);
  if (!ALLOWED.has(product)) {
    return res.status(400).json({ error: "invalid_product" });
  }

  // If busy → queue (when enabled)
  const isBusy = !(await gpuAvailable());
  if (isBusy) {
    if (ENABLE_QUEUE) {
      try {
        const position = await enqueue({ product, minutes, customer, payment, at: Date.now(), idem });
        console.log("queued_job", { position, product, minutes, email: customer?.email });
        return res.status(200).json({ status: "queued", position });
      } catch (e) {
        console.error("queue_error", e.message || e);
        return res.status(503).json({ status: "queue_unavailable", error: String(e.message || e) });
      }
    }
    return res.status(409).json({ status: "busy", message: "GPU busy" });
  }

  // Available → run now
  try {
    const out = await runJob({ product, minutes, customer, payment });
    return res.json({ ...out, idempotency_key: idem });
  } catch (e) {
    console.error("deploy_error", e.message || e);
    return res.status(500).json({ status: "error", error: String(e.message || e) });
  }
});

// ---- Queue worker ----
let inFlight = false;
async function processQueueOnce() {
  if (!ENABLE_QUEUE) return;
  if (inFlight) return;
  if (!(await gpuAvailable())) return;

  const next = await dequeue();
  if (!next) return;

  inFlight = true;
  try {
    console.log("dequeue_start", { product: next.product, minutes: next.minutes, email: next.customer?.email });
    const out = await runJob(next);
    console.log("dequeue_done", out);
  } catch (e) {
    console.error("queue_run_error", e.message || e);
  } finally {
    inFlight = false;
  }
}
if (ENABLE_QUEUE) {
  setInterval(processQueueOnce, 10_000); // every 10s
}

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("deployer up on", port));

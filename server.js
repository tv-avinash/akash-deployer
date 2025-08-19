import express from "express";
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- ENV ----
const AKASH_NODE   = process.env.AKASH_NODE   || "https://rpc.akashnet.net:443";
const AKASH_CHAIN  = process.env.AKASH_CHAIN  || "akashnet-2";
const FROM         = process.env.AKASH_FROM   || "tenant";
const MNEMONIC     = process.env.AKASH_MNEMONIC;            // 24 words (secret)
const KEYRING_BACK = process.env.KEYRING_BACKEND || "test"; // non-interactive
const PROVIDER     = process.env.PROVIDER_ADDR;             // akash1...
const MIN_DEPOSIT  = process.env.MIN_DEPOSIT || "5000000uakt";
const BUSY_CHECK   = process.env.BUSY_CHECK_URL || "";      // optional

// NEW: flags for safe testing
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const DISABLE_BUSY_CHECK = /^(1|true|yes)$/i.test(process.env.DISABLE_BUSY_CHECK || "");

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

async function gpuAvailable() {
  if (DISABLE_BUSY_CHECK || !BUSY_CHECK) return true;
  try {
    const r = await fetch(BUSY_CHECK, { cache: "no-store" });
    const j = await r.json();
    return j?.status === "available";
  } catch { return true; }
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

// --- main endpoint ---
app.post("/", async (req, res) => {
  const idem = req.headers["idempotency-key"];
  const { product, minutes = 60, customer, payment } = req.body || {};

  // validate first (so tests work even if busy)
  const ALLOWED = new Set(["whisper", "sd", "llama"]);
  if (!ALLOWED.has(product)) {
    return res.status(400).json({ error: "invalid_product" });
  }

  // DRY RUN: short-circuit here (no lease, no spend)
  if (DRY_RUN) {
    const uri = `https://demo.indianode.com/job/${product}-${Date.now() % 1e6}`;
    console.log("dry_run_accept", { idem, product, minutes, customer, payment, uri });
    return res.json({ status: "ok", uri, idempotency_key: idem, dry_run: true });
  }

  // respect busy check unless disabled
  if (!(await gpuAvailable())) {
    return res.status(409).json({ status: "busy", message: "GPU busy" });
  }

  try {
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

    // 5) auto-close later
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

    return res.json({ status: "ok", uri, dseq, gseq, oseq, provider, idempotency_key: idem, customer, payment });
  } catch (e) {
    console.error("deploy_error", e.message || e);
    return res.status(500).json({ status: "error", error: String(e.message || e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("deployer up on", port));

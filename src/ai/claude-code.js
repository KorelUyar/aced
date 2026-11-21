// "Claude Code on this Mac": uses the person's own Claude Code login, so no key is needed.
// Claude Code runs as a child process with every tool switched off: it gets text in and gives
// JSON out, and cannot read files or run anything, whatever a PDF says.
//
// This file also knows the three states the person can be in (Claude Code not installed, not
// signed in or the sign-in expired, signed in) and how to start Claude Code's own sign-in.
const { app, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });
const SETUP_PAGE = "https://code.claude.com/docs/en/setup";

// An app started from the Dock gets none of what the shell profile sets (PATH, the folder
// Claude Code keeps its login in, a token). The person's shell is asked once, in the
// background, right after launch. Nothing waits on a child process synchronously: that would
// freeze the app.
//
// What this app's own process happens to carry is not passed on (Spurt may itself have been
// started from inside a Claude Code session, whose variables would confuse the child). What the
// person's shell profile sets is: that is how Claude Code finds their login in a terminal, and
// it must find the same one here.
const FOREIGN = /^(CLAUDECODE$|CLAUDE_|ANTHROPIC_|ELECTRON_)/;
let shellEnv = null;
function readShellEnv() {
  if (shellEnv) return shellEnv;
  shellEnv = new Promise((resolve) => {
    const base = {};
    for (const [key, value] of Object.entries(process.env)) if (!FOREIGN.test(key)) base[key] = value;
    const user = os.userInfo();
    // Claude Code finds its keychain entry by user name.
    base.HOME = base.HOME || user.homedir;
    base.USER = base.USER || user.username;
    base.LOGNAME = base.LOGNAME || user.username;
    if (process.platform === "win32") return resolve(base);
    const shell = base.SHELL && fs.existsSync(base.SHELL) ? base.SHELL : "/bin/zsh";
    const marker = "__SPURT_ENV__";
    let out = "";
    let child;
    try {
      child = spawn(shell, ["-ilc", `printf '${marker}'; command env -0`], { env: base, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(base);
    }
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(base));
    child.on("close", () => {
      clearTimeout(timer);
      const at = out.indexOf(marker);
      if (at >= 0) {
        for (const entry of out.slice(at + marker.length).split("\0")) {
          const eq = entry.indexOf("=");
          if (eq > 0 && !/^ELECTRON_/.test(entry)) base[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }
      resolve(base);
    });
  });
  return shellEnv;
}

async function environment() {
  const env = { ...(await readShellEnv()) };
  const home = os.homedir();
  env.PATH = [env.PATH, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");
  return env;
}

async function locate() {
  // A stand-in for Claude Code in tests. Never in the app people install.
  if (!app.isPackaged && process.env.SPURT_CLAUDE) return fs.existsSync(process.env.SPURT_CLAUDE) ? process.env.SPURT_CLAUDE : undefined;
  const env = await environment();
  const home = os.homedir();
  const candidates = [
    ...env.PATH.split(":").map((p) => path.join(p, "claude")),
    `${home}/.claude/local/claude`,
    `${home}/.npm-global/bin/claude`,
  ];
  return candidates.find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function run(exe, env, args, input, signal, limit = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-cc-"));
    const child = spawn(exe, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), limit);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      fs.rm(cwd, { recursive: true, force: true }, () => {});
      reject(coded("provider", "Claude Code: " + e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fs.rm(cwd, { recursive: true, force: true }, () => {});
      if (signal?.aborted) return reject(coded("cancelled"));
      resolve({ out, err, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// ------------------------------------------------------------ signed in or not

// A request that failed because of the sign-in is remembered until the sign-in changes, so
// Settings can say "expired" even though Claude Code itself still reports a stored login.
let failed = null; // { reason, expiresAt } at the time of the failure

/** How Claude Code says that the person has to sign in (again). Returns "signedOut", "expired" or null. */
function signInProblem(message) {
  if (/not logged in|please run \/login/i.test(message)) return "signedOut";
  if (/oauth|session expired|could not be refreshed|failed to authenticate|authentication_error|invalid (api key|bearer token|x-api-key)|\b401\b|unauthori[sz]ed/i.test(message)) return "expired";
  return null;
}

/**
 * Where the person stands: { installed, signedIn, expired, expiresAt }.
 * `signedIn` is null when Claude Code is there but would not say.
 */
async function status() {
  const exe = await locate();
  if (!exe) return { installed: false, signedIn: false, expired: false, expiresAt: null };
  let info = null;
  try {
    const { out } = await run(exe, await environment(), ["auth", "status", "--json"], "", undefined, 20000);
    info = JSON.parse(out);
  } catch {
    // an older Claude Code without this command, or it did not answer
  }
  if (!info || typeof info.loggedIn !== "boolean") return { installed: true, signedIn: null, expired: Boolean(failed), expiresAt: null };
  const expiresAt = info.loginExpiresAt || null;
  // A new sign-in has another end date: what failed before no longer counts.
  if (failed && (!info.loggedIn || expiresAt !== failed.expiresAt)) failed = null;
  const past = Boolean(expiresAt) && Date.parse(expiresAt) < Date.now();
  return { installed: true, signedIn: info.loggedIn, expired: info.loggedIn && (past || Boolean(failed)), expiresAt };
}

/**
 * Starts Claude Code's own sign-in, in a Terminal window: it opens the browser, and takes a
 * code there if the browser cannot hand it over by itself. Spurt only starts it and then looks
 * at `status()` until the person is signed in.
 */
async function signIn(lang) {
  const exe = await locate();
  if (!exe) throw coded("noClaudeCode");
  failed = null;
  const quoted = "'" + exe.replace(/'/g, "'\\''") + "'";
  const say =
    lang === "de"
      ? ["Spurt: Anmeldung bei Claude Code.", "Dein Browser öffnet sich. Melde dich dort an und geh dann zurück zu Spurt.", "Fertig. Du kannst dieses Fenster schliessen.", "Die Anmeldung wurde nicht abgeschlossen. Du kannst sie in den Einstellungen von Spurt nochmals starten."]
      : ["Spurt: signing in to Claude Code.", "Your browser opens. Sign in there, then go back to Spurt.", "Done. You can close this window.", "The sign-in did not finish. You can start it again in Spurt's Settings."];
  const script = `#!/bin/zsh -l
clear
echo "${say[0]}"
echo "${say[1]}"
echo
${quoted} auth login
if [ $? -eq 0 ]; then echo; echo "${say[2]}"; else echo; echo "${say[3]}"; fi
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spurt-signin-"));
  const file = path.join(dir, lang === "de" ? "Bei Claude Code anmelden.command" : "Sign in to Claude Code.command");
  fs.writeFileSync(file, script, { mode: 0o755 });
  // In tests the script runs without a window. Never in the app people install.
  if (!app.isPackaged && process.env.SPURT_SIGNIN === "run") {
    spawn("/bin/zsh", [file], { env: await environment(), stdio: "ignore" });
    return;
  }
  const problem = await shell.openPath(file);
  if (problem) throw coded("provider", problem);
}

// ------------------------------------------------------------ a request

async function attempt(exe, env, request, settingSources) {
  const { model, system, material, prompt, schema, effort, signal } = request;
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--model", model,
    "--effort", effort,
    "--system-prompt", system,
    "--tools", "",
    "--setting-sources", settingSources,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  const { out, err } = await run(exe, env, args, (material ? material + "\n\n" : "") + prompt, signal);
  let json;
  try {
    json = JSON.parse(out);
  } catch {
    const text = (out || err || "no output").trim();
    const reason = signInProblem(text);
    if (reason) throw coded("signIn", reason);
    throw coded("provider", "Claude Code: " + text.slice(0, 300));
  }
  if (json.is_error) {
    const message = String(json.result || "error");
    const reason = signInProblem(message);
    if (reason) throw coded("signIn", reason);
    if (/usage limit|rate limit/i.test(message)) throw coded("rateLimit");
    throw coded("provider", "Claude Code: " + message.slice(0, 300));
  }
  const u = json.usage || {};
  return {
    text: json.structured_output || json.result || "",
    usage: {
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    },
  };
}

async function complete(request) {
  const exe = await locate();
  if (!exe) throw coded("noClaudeCode");
  const env = await environment();
  try {
    const answer = await attempt(exe, env, request, "");
    failed = null;
    return answer;
  } catch (err) {
    if (err.code !== "signIn") throw err;
    // The login may come from the person's own settings (an API key helper, for example).
    try {
      const answer = await attempt(exe, env, request, "user");
      failed = null;
      return answer;
    } catch (second) {
      if (second.code === "signIn") {
        const now = await status().catch(() => null);
        failed = { reason: second.detail, expiresAt: now ? now.expiresAt : null };
      }
      throw second;
    }
  }
}

module.exports = { complete, locate, status, signIn, signInProblem, warm: readShellEnv, SETUP_PAGE };

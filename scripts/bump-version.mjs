#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_JSON_PATHS = [
  path.join(ROOT, "cli", "package.json"),
  path.join(ROOT, "package.json"),
  path.join(ROOT, "cli", "app", "package.json"),
];

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;

function readVersion(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/"version"\s*:\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`No "version" field in ${filePath}`);
  }
  return match[1];
}

function bumpSemver(current, kind) {
  const m = current.match(SEMVER_RE);
  if (!m) {
    throw new Error(`Not a semver x.y.z: ${current}`);
  }
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);

  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else if (kind === "patch") {
    patch += 1;
  } else {
    throw new Error(`Unknown bump kind: ${kind}`);
  }

  return `${major}.${minor}.${patch}`;
}

function writeVersion(filePath, newVersion) {
  const raw = fs.readFileSync(filePath, "utf8");
  const updated = raw.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${newVersion}$2`,
  );
  if (updated === raw) {
    throw new Error(`Could not update version in ${filePath}`);
  }
  fs.writeFileSync(filePath, updated);
}

function usage() {
  console.error(`Usage: node scripts/bump-version.mjs [patch|minor|major|<x.y.z>] [--dry-run]

Bumps cli/package.json and syncs version to package.json and cli/app/package.json.
Default: patch`);
}

const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const dryRun = process.argv.includes("--dry-run");
const arg = args[0] ?? "patch";

const sourcePath = PACKAGE_JSON_PATHS[0];
const current = readVersion(sourcePath);

let next;
if (SEMVER_RE.test(arg)) {
  next = arg;
} else if (arg === "patch" || arg === "minor" || arg === "major") {
  next = bumpSemver(current, arg);
} else {
  usage();
  process.exit(1);
}

if (next === current) {
  console.error(`Version unchanged: ${current}`);
  process.exit(1);
}

console.log(`${current} -> ${next}`);

if (dryRun) {
  process.exit(0);
}

for (const filePath of PACKAGE_JSON_PATHS) {
  writeVersion(filePath, next);
  console.log(`  updated ${path.relative(ROOT, filePath)}`);
}

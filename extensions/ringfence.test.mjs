// node extensions/ringfence.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand, checkPath } from "./ringfence.ts";

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rf-"));
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "src/a.ts"), "x");
fs.symlinkSync(os.homedir(), path.join(root, "escape"));

const ok = [
	["read", "src/a.ts"],
	["read", path.join(root, "src/a.ts")],
	["bash", "ls -la && grep -rn foo src | head -20"],
	["bash", "git status 2>/dev/null > /dev/null"],
	["bash", "sed -i '' 's|/a/b|/c/d|' src/a.ts"],
	["bash", "npm i -D foo@~1.2.3"],
	["bash", "npm install && npm test"],
	["bash", "rm -rf node_modules dist"],
	["bash", "cat ./etc/settings.json"],
	["bash", `cat ${root}/src/a.ts`],
	["bash", "TMP=/tmp-ish echo ok"],
];
const bad = [
	["read", "../../etc/passwd"],
	["read", "~/.ssh/id_rsa"],
	["read", "/etc/passwd"],
	["read", path.join(root, "escape/.ssh")], // symlink out
	["write", "/tmp/x"],
	["bash", "cat ../../secret"],
	["bash", "cd .. && ls"],
	["bash", "cat ~/.aws/credentials"],
	["bash", "echo $HOME/.netrc"],
	["bash", "python3 /Users/me/other/repo/x.py"],
	["bash", "ln -s /etc etc"],
	["bash", "python3 -c \"print(open('/etc/hosts').read())\""], // quoted program body
	["bash", 'python3 -c \'open("' + os.homedir() + '/.netrc")\''],
	["bash", "npm i -g typescript"],
	["bash", "pip3 install --user ruff"],
	["bash", "brew install wget"],
	["bash", "sudo defaults write /tmp/x y -bool yes"],
	["bash", "security find-generic-password -w"],
	["bash", "git push --force origin main"],
	["bash", "rm -rf ~/Library"],
];

for (const [tool, arg] of ok) {
	const why = tool === "bash" ? checkCommand(arg, root) : checkPath(arg, root);
	assert.equal(why, undefined, `false positive: ${arg} -> ${why}`);
}
for (const [tool, arg] of bad) {
	const why = tool === "bash" ? checkCommand(arg, root) : checkPath(arg, root);
	assert.ok(why, `missed escape: ${arg}`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`ringfence: ${ok.length + bad.length} cases pass`);

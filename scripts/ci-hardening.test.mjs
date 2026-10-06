/**
 * Guards the CI workflows' supply-chain settings: a read-only default token
 * and third-party actions pinned to a full commit SHA (a moved or hijacked
 * tag cannot change what runs), each with the release tag in a comment so
 * updates stay readable.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

describe('CI workflows', () => {
  it('exist', () => assert.ok(workflows.length > 0));

  for (const file of workflows) {
    const text = readFileSync(join(dir, file), 'utf8');

    it(`${file} defaults the token to read-only contents`, () => {
      assert.match(text, /^permissions:\n {2}contents: read$/m);
    });

    it(`${file} pins every action by commit SHA with its tag noted`, () => {
      const uses = [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)];
      assert.ok(uses.length > 0);
      for (const [, ref, rest] of uses) {
        if (ref.startsWith('./')) continue;
        assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${ref} is not pinned to a SHA`);
        assert.match(rest, /#\s*v\d/, `${file}: ${ref} has no tag comment`);
      }
    });
  }
});

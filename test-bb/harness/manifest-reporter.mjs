// Fails the run unless every test listed in test-bb/manifest.json was discovered AND passed, nothing else ran,
// and nothing was skipped. Prints the actual totals so CI logs carry the evidence.
import fs from 'node:fs';
import path from 'node:path';

export default class ManifestReporter {
  onBegin(config, suite) {
    this.manifest = JSON.parse(fs.readFileSync(path.join(config.rootDir, 'manifest.json'), 'utf8')).tests;
    this.discovered = suite.allTests().map((t) => t.titlePath().slice(-2).join(' › '));
    this.results = new Map();
  }

  onTestEnd(test, result) {
    const id = test.titlePath().slice(-2).join(' › ');
    this.results.set(id, test.outcome());
    void result;
  }

  onEnd(result) {
    const problems = [];
    const want = new Set(this.manifest);
    const got = new Set(this.discovered);
    for (const t of want) if (!got.has(t)) problems.push(`missing from discovery: ${t}`);
    for (const t of got) if (!want.has(t)) problems.push(`not in manifest: ${t}`);
    const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    for (const [id, outcome] of this.results) {
      counts[outcome] = (counts[outcome] || 0) + 1;
      if (outcome !== 'expected') problems.push(`${outcome}: ${id}`);
    }
    for (const t of want) if (!this.results.has(t)) problems.push(`did not run: ${t}`);
    console.log(`\n[bb] manifest ${want.size} · discovered ${got.size} · passed ${counts.expected} · failed ${counts.unexpected} · flaky ${counts.flaky} · skipped ${counts.skipped}`);
    if (problems.length) {
      console.log(`[bb] MANIFEST CHECK FAILED\n  - ${problems.join('\n  - ')}`);
      return { status: 'failed' };
    }
    console.log('[bb] manifest check passed: every listed scenario ran and passed, none skipped');
    return { status: result.status };
  }

  printsToStdio() { return false; }
}

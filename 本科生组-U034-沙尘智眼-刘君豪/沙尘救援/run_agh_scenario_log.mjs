import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(__dirname, 'agh_scenario_run.jsonl');
const proc = spawn('node', ['agh_scenario_run.mjs'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'inherit'] });
let buffer = '';
const lines = [];
proc.stdout.on('data', chunk => {
  buffer += chunk.toString();
  const next = buffer.split(/\r?\n/);
  buffer = next.pop();
  for (const line of next) if (line.trim()) lines.push(line.trim());
});
proc.on('close', code => {
  const rawOutput = lines.join('\n') + (buffer.trim() ? '\n' + buffer.trim() : '');
  const linesArr = rawOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  const records = [];
  let allPassed = null;

  for (let idx = 0; idx < linesArr.length; idx++) {
    const line = linesArr[idx];
    try {
      const parsed = JSON.parse(line);
      records.push(parsed);
      if (parsed && typeof parsed === 'object' && 'allPassed' in parsed) allPassed = parsed.allPassed;
    } catch (err) {
      // 若当前行是末尾多行 JSON 的开头，需要合并后续行再解析。
      const start = linesArr.slice(idx).join('\n');
      const next = JSON.parse(start);
      records.push(next);
      if (next && typeof next === 'object' && 'allPassed' in next) allPassed = next.allPassed;
      break;
    }
  }

  for (const record of records) appendFileSync(logFile, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  console.log(`agh_scenario_run log written: ${logFile} (${records.length} records)`);
  console.log(`exitCode=${code} allPassed=${allPassed}`);
  process.exitCode = code;
});

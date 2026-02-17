/**
 * Classify QA/ticket failures into structured categories.
 */

export type FailureType = 'compile_error' | 'type_error' | 'test_assertion' | 'runtime_error' | 'lint_error' | 'timeout' | 'unknown';

export interface ClassifiedFailure {
  failureType: FailureType;
  failedCommand: string;
  errorPattern: string;
}

export function classifyFailure(stepName: string, output: string): ClassifiedFailure {
  const tail = output.slice(-5000);
  let failureType: FailureType = 'unknown';

  if (/\berror TS\d+\b|TS\d+:/.test(tail)) failureType = 'type_error';
  else if (/Cannot find module|SyntaxError|Module not found/.test(tail)) failureType = 'compile_error';
  else if (/FAIL|AssertionError|expect\(|assert\.|✗/.test(tail) && /test|spec/i.test(stepName)) failureType = 'test_assertion';
  else if (/eslint|prettier|lint/i.test(stepName)) failureType = 'lint_error';
  else if (/SIGTERM|timed?\s*out|ETIMEDOUT/i.test(tail)) failureType = 'timeout';
  else if (/ReferenceError|TypeError|Error:|ENOENT|EACCES/.test(tail)) failureType = 'runtime_error';

  const lines = tail.split('\n');
  const errorLine = lines.find(l => /^(error|Error|FAIL|✗|×|FAILED)/i.test(l.trim()));
  const errorPattern = (errorLine ?? '').trim().slice(0, 100);

  return { failureType, failedCommand: stepName, errorPattern };
}

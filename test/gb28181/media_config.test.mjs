import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceMediaConfig} from '../../deploy-package/gb28181/media-config.mjs';

test('real audio policy preserves endpoints and unrelated protocol options', () => {
  const original = '[api]\nsecret=test-only\n[http]\nport=8097\n[protocol]\nenable_mp4=0\nadd_mute_audio=1\nmodify_stamp=2\n[rtsp]\nport=8556\n';
  const result = sourceMediaConfig(original);
  assert.match(result, /secret=test-only\n/);
  assert.match(result, /enable_mp4=0\n/);
  assert.match(result, /\[rtsp\]\nport=8556\n/);
  assert.match(result, /enable_audio=1\nadd_mute_audio=0\nmodify_stamp=0\n/);
  assert.doesNotMatch(result, /add_mute_audio=1/);
  assert.equal(sourceMediaConfig(result), result);
});

test('default protocol section is explicit and ambiguous sections are rejected', () => {
  const result = sourceMediaConfig('[http]\nport=8097\n');
  assert.match(result, /\[protocol\]\nenable_audio=1\nadd_mute_audio=0\nmodify_stamp=0\n$/);
  assert.equal(sourceMediaConfig(result), result);
  assert.throws(() => sourceMediaConfig('[protocol]\n[protocol]\n'), /Duplicate/);
});

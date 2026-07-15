import { describe, expect, it } from 'vitest';

import { detectBinary } from '../../src/services/fs/fsService';

describe('filesystem binary detection', () => {
  it('treats UTF-8 Chinese markdown as text', () => {
    expect(detectBinary(Buffer.from('# 项目说明\n\n这是中文 Markdown 文档。\n', 'utf8'))).toBe(false);
  });

  it('rejects NUL bytes and invalid UTF-8', () => {
    expect(detectBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(detectBinary(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(true);
  });
});

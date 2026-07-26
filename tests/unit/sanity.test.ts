import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('mescla classes tailwind resolvendo conflitos', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});

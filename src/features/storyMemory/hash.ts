/** Content hashing for change-detection. Kept dependency-free (no vscode) so the
 *  extraction pipeline can run in a standalone harness/eval as well as the host. */
import { createHash } from 'crypto';

export function hashContent(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

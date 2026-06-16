import * as vscode from 'vscode';
import { STATE_USER_DICTIONARY } from '../../constants';

/** Persistent set of words the user has added to their personal dictionary,
 *  stored (lowercased) in globalState so it follows them across workspaces. */
export class UserDictionary {
  private words: Set<string>;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.globalState.get<string[]>(STATE_USER_DICTIONARY, []);
    this.words = new Set(stored.map((w) => w.toLowerCase()));
  }

  has(word: string): boolean {
    return this.words.has(word.toLowerCase());
  }

  all(): string[] {
    return Array.from(this.words);
  }

  async add(word: string): Promise<void> {
    const key = word.toLowerCase();
    if (this.words.has(key)) {
      return;
    }
    this.words.add(key);
    await this.context.globalState.update(STATE_USER_DICTIONARY, Array.from(this.words));
  }
}

/**
 * The "you hit your daily target" celebration card: a script-free webview opened
 * beside the editor (like the Dictionary panel) with a CSS-only confetti rain.
 * Shown at most once per day by the daily-goal feature; the author just closes
 * the tab when they've soaked it in.
 */

import * as vscode from 'vscode';
import { presizeSidePanel } from '../../util/editorLayout';

const VIEW_TYPE = 'proser.dailyGoalCelebration';
const SIDE_PANEL_PX = 420;

let panel: vscode.WebviewPanel | undefined;

export function showCelebrationCard(
  context: vscode.ExtensionContext,
  written: number,
  target: number
): void {
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
  } else {
    panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Target Hit!',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: false }
    );
    presizeSidePanel(context.globalState, SIDE_PANEL_PX);
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'proser.svg');
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.webview.html = page(written, target);
}

const CONFETTI_COLORS = [
  '#f94144',
  '#f3722c',
  '#f8961e',
  '#f9c74f',
  '#90be6d',
  '#43aa8b',
  '#577590',
  '#c77dff'
];

/** ~60 falling pieces with randomized column, delay, speed, size, and spin. */
function confetti(): string {
  let out = '';
  for (let i = 0; i < 60; i++) {
    const left = (Math.random() * 100).toFixed(1);
    const delay = (Math.random() * 4).toFixed(2);
    const duration = (3 + Math.random() * 3).toFixed(2);
    const size = (6 + Math.random() * 6).toFixed(0);
    const spin = (360 + Math.random() * 720).toFixed(0);
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    out +=
      `<i style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;` +
      `width:${size}px;height:${Math.round(Number(size) * 1.6)}px;background:${color};--spin:${spin}deg"></i>`;
  }
  return out;
}

function page(written: number, target: number): string {
  const date = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body {
    height: 100%;
    margin: 0;
    overflow: hidden;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .wrap {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    box-sizing: border-box;
  }
  .card {
    text-align: center;
    padding: 40px 32px;
    max-width: 340px;
    border-radius: 16px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 12px 40px rgba(0,0,0,0.25);
    animation: pop 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) both;
  }
  @keyframes pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .emoji { font-size: 64px; line-height: 1; animation: bounce 1.6s ease-in-out infinite; display: inline-block; }
  @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
  h1 { font-size: 22px; margin: 18px 0 6px; }
  .date { opacity: 0.6; font-size: 12px; margin-bottom: 18px; }
  .count { font-size: 34px; font-weight: 700; color: var(--vscode-charts-green, #89d185); }
  .target { opacity: 0.75; font-size: 13px; margin-top: 4px; }
  .cheer { margin-top: 22px; font-size: 13px; opacity: 0.8; font-style: italic; }
  .confetti i {
    position: fixed;
    top: -24px;
    display: block;
    border-radius: 2px;
    opacity: 0.9;
    animation-name: fall;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }
  @keyframes fall { to { transform: translateY(110vh) rotate(var(--spin)); } }
</style>
</head>
<body>
  <div class="confetti" aria-hidden="true">${confetti()}</div>
  <div class="wrap">
    <div class="card">
      <span class="emoji">🎉</span>
      <h1>Daily target reached!</h1>
      <div class="date">${date}</div>
      <div class="count">${written.toLocaleString()} words</div>
      <div class="target">of your ${target.toLocaleString()}-word daily target</div>
      <div class="cheer">The manuscript grows. Keep going — or celebrate, you've earned it.</div>
    </div>
  </div>
</body>
</html>`;
}

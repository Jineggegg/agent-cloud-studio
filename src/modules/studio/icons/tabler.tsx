import type { SVGProps } from 'react';

/*
 * Studio's line icons: Tabler Icons 3.48.0 (https://tabler.io/icons), outline style. Only the icons Studio uses are
 * vendored here, as the path data of the @tabler/icons package's tabler-nodes-outline.json, so no dependency is added.
 * Products with an official mark (GitHub, Claude, OpenAI, DeepSeek …) use it instead (brandIcons).
 *
 * MIT License
 *
 * Copyright (c) 2020-2026 Paweł Kuna
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Every Tabler outline icon is drawn with paths only, so each icon is its list of path data.
const TABLER_PATHS = {
  'activity': ['M3 12h4l3 8l4 -16l3 8h4'],
  'adjustments-horizontal': ['M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 6l8 0', 'M16 6l4 0', 'M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 12l2 0', 'M10 12l10 0', 'M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 18l11 0', 'M19 18l1 0'],
  'alert-triangle': ['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0', 'M12 16h.01'],
  'arrow-down-right': ['M7 7l10 10', 'M17 8l0 9l-9 0'],
  'arrow-up': ['M12 5l0 14', 'M18 11l-6 -6', 'M6 11l6 -6'],
  'arrow-up-right': ['M17 7l-10 10', 'M8 7l9 0l0 9'],
  'book': ['M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0', 'M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0', 'M3 6l0 13', 'M12 6l0 13', 'M21 6l0 13'],
  'calendar-time': ['M11.795 21h-6.795a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v4', 'M14 18a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M15 3v4', 'M7 3v4', 'M3 11h16', 'M18 16.496v1.504l1 1'],
  'chart-candle': ['M4 7a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -3', 'M6 4l0 2', 'M6 11l0 9', 'M10 15a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -3', 'M12 4l0 10', 'M12 19l0 1', 'M16 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -4', 'M18 4l0 1', 'M18 11l0 9'],
  'chart-line': ['M4 19l16 0', 'M4 15l4 -6l4 2l4 -5l4 4'],
  'chart-pie': ['M10 3.2a9 9 0 1 0 10.8 10.8a1 1 0 0 0 -1 -1h-6.8a2 2 0 0 1 -2 -2v-7a.9 .9 0 0 0 -1 -.8', 'M15 3.5a9 9 0 0 1 5.5 5.5h-4.5a1 1 0 0 1 -1 -1v-4.5'],
  'check': ['M5 12l5 5l10 -10'],
  'chevron-down': ['M6 9l6 6l6 -6'],
  'chevron-left': ['M15 6l-6 6l6 6'],
  'chevron-right': ['M9 6l6 6l-6 6'],
  'circle-check': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9 12l2 2l4 -4'],
  'circle-dashed': ['M8.56 3.69a9 9 0 0 0 -2.92 1.95', 'M3.69 8.56a9 9 0 0 0 -.69 3.44', 'M3.69 15.44a9 9 0 0 0 1.95 2.92', 'M8.56 20.31a9 9 0 0 0 3.44 .69', 'M15.44 20.31a9 9 0 0 0 2.92 -1.95', 'M20.31 15.44a9 9 0 0 0 .69 -3.44', 'M20.31 8.56a9 9 0 0 0 -1.95 -2.92', 'M15.44 3.69a9 9 0 0 0 -3.44 -.69'],
  'circle-minus': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9 12l6 0'],
  'circle-x': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M10 10l4 4m0 -4l-4 4'],
  'copy': ['M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666', 'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1'],
  'device-floppy': ['M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2', 'M10 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M14 4l0 4l-6 0l0 -4'],
  'cpu': ['M5 6a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1l0 -12', 'M9 9h6v6h-6l0 -6', 'M3 10h2', 'M3 14h2', 'M10 3v2', 'M14 3v2', 'M21 10h-2', 'M21 14h-2', 'M14 21v-2', 'M10 21v-2'],
  'cursor-text': ['M10 12h4', 'M9 4a3 3 0 0 1 3 3v10a3 3 0 0 1 -3 3', 'M15 4a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3'],
  'devices': ['M13 9a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-10', 'M18 8v-3a1 1 0 0 0 -1 -1h-13a1 1 0 0 0 -1 1v12a1 1 0 0 0 1 1h9', 'M16 9h2'],
  'edit': ['M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1', 'M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415', 'M16 5l3 3'],
  'external-link': ['M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6', 'M11 13l9 -9', 'M15 4h5v5'],
  'eye': ['M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6'],
  'eye-off': ['M10.585 10.587a2 2 0 0 0 2.829 2.828', 'M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87', 'M3 3l18 18'],
  'face-id': ['M4 8v-2a2 2 0 0 1 2 -2h2', 'M4 16v2a2 2 0 0 0 2 2h2', 'M16 4h2a2 2 0 0 1 2 2v2', 'M16 20h2a2 2 0 0 0 2 -2v-2', 'M9 10l.01 0', 'M15 10l.01 0', 'M9.5 15a3.5 3.5 0 0 0 5 0'],
  'file-text': ['M14 3v4a1 1 0 0 0 1 1h4', 'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2', 'M9 9l1 0', 'M9 13l6 0', 'M9 17l6 0'],
  'folder': ['M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2'],
  'folder-x': ['M13.5 19h-8.5a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v4', 'M22 22l-5 -5', 'M17 22l5 -5'],
  'git-branch': ['M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M7 8l0 8', 'M9 18h6a2 2 0 0 0 2 -2v-5', 'M14 14l3 -3l3 3'],
  'git-merge': ['M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M15 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M7 8l0 8', 'M7 8a4 4 0 0 0 4 4h4'],
  'git-pull-request': ['M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M6 8l0 8', 'M11 6h5a2 2 0 0 1 2 2v8', 'M14 9l-3 -3l3 -3'],
  'gauge': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M13.41 10.59l2.59 -2.59', 'M7 12a5 5 0 0 1 5 -5'],
  'git-pull-request-draft': ['M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M6 8v8', 'M18 11h.01', 'M18 6h.01'],
  'inbox': ['M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12', 'M4 13h3l3 3h4l3 -3h3'],
  'info-circle': ['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M12 9h.01', 'M11 12h1v4h1'],
  'key': ['M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0', 'M15 9h.01'],
  'layout-grid': ['M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4'],
  'loader-2': ['M12 3a9 9 0 1 0 9 9'],
  'lock': ['M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6', 'M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0', 'M8 11v-4a4 4 0 1 1 8 0v4'],
  'logout': ['M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2', 'M9 12h12l-3 -3', 'M18 15l3 -3'],
  'mail': ['M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10', 'M3 7l9 6l9 -6'],
  'messages': ['M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10', 'M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2'],
  'minus': ['M5 12l14 0'],
  'moon': ['M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454l0 .008'],
  'network': ['M6 9a6 6 0 1 0 12 0a6 6 0 0 0 -12 0', 'M12 3c1.333 .333 2 2.333 2 6s-.667 5.667 -2 6', 'M12 3c-1.333 .333 -2 2.333 -2 6s.667 5.667 2 6', 'M6 9h12', 'M3 20h7', 'M14 20h7', 'M10 20a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M12 15v3'],
  'pencil': ['M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4', 'M13.5 6.5l4 4'],
  'pin': ['M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4', 'M9 15l-4.5 4.5', 'M14.5 4l5.5 5.5'],
  'plug': ['M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054', 'M4 20l3.5 -3.5', 'M15 4l-3.5 3.5', 'M20 9l-3.5 3.5'],
  'plus': ['M12 5l0 14', 'M5 12l14 0'],
  'refresh': ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'],
  'rotate': ['M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5'],
  'rotate-clockwise': ['M4.05 11a8 8 0 1 1 .5 4m-.5 5v-5h5'],
  'route': ['M3 19a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M19 7a2 2 0 1 0 0 -4a2 2 0 0 0 0 4', 'M11 19h5.5a3.5 3.5 0 0 0 0 -7h-8a3.5 3.5 0 0 1 0 -7h4.5'],
  'school': ['M22 9l-10 -4l-10 4l10 4l10 -4v6', 'M6 10.6v5.4a6 3 0 0 0 12 0v-5.4'],
  'search': ['M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6'],
  'search-off': ['M5.039 5.062a7 7 0 0 0 9.91 9.89m1.584 -2.434a7 7 0 0 0 -9.038 -9.057', 'M3 3l18 18'],
  'server': ['M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-2', 'M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2', 'M7 8l0 .01', 'M7 16l0 .01'],
  'server-off': ['M12 12h-6a3 3 0 0 1 -3 -3v-2c0 -1.083 .574 -2.033 1.435 -2.56m3.565 -.44h10a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-2', 'M16 12h2a3 3 0 0 1 3 3v2m-1.448 2.568a2.986 2.986 0 0 1 -1.552 .432h-12a3 3 0 0 1 -3 -3v-2a3 3 0 0 1 3 -3h6', 'M7 8v.01', 'M7 16v.01', 'M3 3l18 18'],
  'settings': ['M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065', 'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0'],
  'shield-check': ['M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06', 'M15 19l2 2l4 -4'],
  'shield-exclamation': ['M15.04 19.745c-.942 .551 -1.964 .976 -3.04 1.255a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 .195 6.015', 'M19 16v3', 'M19 22v.01'],
  'shield-x': ['M13.252 20.601c-.408 .155 -.826 .288 -1.252 .399a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.19 7.357', 'M22 22l-5 -5', 'M17 22l5 -5'],
  'sparkles': ['M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6'],
  'square': ['M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14'],
  'sun': ['M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7'],
  'terminal-2': ['M8 9l3 3l-3 3', 'M13 15l3 0', 'M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12'],
  'trash': ['M4 7l16 0', 'M10 11l0 6', 'M14 11l0 6', 'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12', 'M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3'],
  'user': ['M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0', 'M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2'],
  'world': ['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M3.6 9h16.8', 'M3.6 15h16.8', 'M11.5 3a17 17 0 0 0 0 18', 'M12.5 3a17 17 0 0 1 0 18'],
  'x': ['M18 6l-12 12', 'M6 6l12 12'],
} satisfies Record<string, readonly string[]>;

type TablerIconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & { size?: number | string };

// The icon itself, drop-in for the lucide icons it replaced: `size`, `strokeWidth` (Tabler's 2 is heavy beside the
// brand marks and Studio's thin type, so 1.75 by default), `className`, `fill` and the other SVG props. Hidden from
// assistive technology unless it is given a label.
function TablerIcon({ name, size = 24, strokeWidth = 1.75, ...props }: TablerIconProps & { name: keyof typeof TABLER_PATHS }) {
  const labelled = Boolean(props['aria-label'] || props['aria-labelledby']);
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={labelled ? undefined : true} focusable="false"
    data-icon={name} {...props}>
    {TABLER_PATHS[name].map(path => <path key={path} d={path} />)}
  </svg>;
}

/*
 * Used across the studio module (home screen, widgets, settings, sheets, apps) and, through StudioTileIcon, by the
 * workbench project switcher: one component per vendored icon, named after its Tabler name.
 */
export const IconActivity = (props: TablerIconProps) => <TablerIcon {...props} name="activity" />;
export const IconAdjustmentsHorizontal = (props: TablerIconProps) => <TablerIcon {...props} name="adjustments-horizontal" />;
export const IconAlertTriangle = (props: TablerIconProps) => <TablerIcon {...props} name="alert-triangle" />;
export const IconArrowDownRight = (props: TablerIconProps) => <TablerIcon {...props} name="arrow-down-right" />;
export const IconArrowUp = (props: TablerIconProps) => <TablerIcon {...props} name="arrow-up" />;
export const IconArrowUpRight = (props: TablerIconProps) => <TablerIcon {...props} name="arrow-up-right" />;
export const IconBook = (props: TablerIconProps) => <TablerIcon {...props} name="book" />;
export const IconCalendarTime = (props: TablerIconProps) => <TablerIcon {...props} name="calendar-time" />;
export const IconChartCandle = (props: TablerIconProps) => <TablerIcon {...props} name="chart-candle" />;
export const IconChartLine = (props: TablerIconProps) => <TablerIcon {...props} name="chart-line" />;
export const IconChartPie = (props: TablerIconProps) => <TablerIcon {...props} name="chart-pie" />;
export const IconCheck = (props: TablerIconProps) => <TablerIcon {...props} name="check" />;
export const IconChevronDown = (props: TablerIconProps) => <TablerIcon {...props} name="chevron-down" />;
export const IconChevronLeft = (props: TablerIconProps) => <TablerIcon {...props} name="chevron-left" />;
export const IconChevronRight = (props: TablerIconProps) => <TablerIcon {...props} name="chevron-right" />;
export const IconCircleCheck = (props: TablerIconProps) => <TablerIcon {...props} name="circle-check" />;
export const IconCircleDashed = (props: TablerIconProps) => <TablerIcon {...props} name="circle-dashed" />;
export const IconCircleMinus = (props: TablerIconProps) => <TablerIcon {...props} name="circle-minus" />;
export const IconCircleX = (props: TablerIconProps) => <TablerIcon {...props} name="circle-x" />;
export const IconCopy = (props: TablerIconProps) => <TablerIcon {...props} name="copy" />;
export const IconDeviceFloppy = (props: TablerIconProps) => <TablerIcon {...props} name="device-floppy" />;
export const IconCpu = (props: TablerIconProps) => <TablerIcon {...props} name="cpu" />;
export const IconCursorText = (props: TablerIconProps) => <TablerIcon {...props} name="cursor-text" />;
export const IconDevices = (props: TablerIconProps) => <TablerIcon {...props} name="devices" />;
export const IconEdit = (props: TablerIconProps) => <TablerIcon {...props} name="edit" />;
export const IconExternalLink = (props: TablerIconProps) => <TablerIcon {...props} name="external-link" />;
export const IconEye = (props: TablerIconProps) => <TablerIcon {...props} name="eye" />;
export const IconEyeOff = (props: TablerIconProps) => <TablerIcon {...props} name="eye-off" />;
export const IconFaceId = (props: TablerIconProps) => <TablerIcon {...props} name="face-id" />;
export const IconFileText = (props: TablerIconProps) => <TablerIcon {...props} name="file-text" />;
export const IconFolder = (props: TablerIconProps) => <TablerIcon {...props} name="folder" />;
export const IconFolderX = (props: TablerIconProps) => <TablerIcon {...props} name="folder-x" />;
export const IconGitBranch = (props: TablerIconProps) => <TablerIcon {...props} name="git-branch" />;
export const IconGitMerge = (props: TablerIconProps) => <TablerIcon {...props} name="git-merge" />;
export const IconGitPullRequest = (props: TablerIconProps) => <TablerIcon {...props} name="git-pull-request" />;
export const IconGauge = (props: TablerIconProps) => <TablerIcon {...props} name="gauge" />;
export const IconGitPullRequestDraft =(props: TablerIconProps) => <TablerIcon {...props} name="git-pull-request-draft" />;
export const IconInbox = (props: TablerIconProps) => <TablerIcon {...props} name="inbox" />;
export const IconInfoCircle = (props: TablerIconProps) => <TablerIcon {...props} name="info-circle" />;
export const IconKey = (props: TablerIconProps) => <TablerIcon {...props} name="key" />;
export const IconLayoutGrid = (props: TablerIconProps) => <TablerIcon {...props} name="layout-grid" />;
export const IconLoader2 = (props: TablerIconProps) => <TablerIcon {...props} name="loader-2" />;
export const IconLock = (props: TablerIconProps) => <TablerIcon {...props} name="lock" />;
export const IconLogout = (props: TablerIconProps) => <TablerIcon {...props} name="logout" />;
export const IconMail = (props: TablerIconProps) => <TablerIcon {...props} name="mail" />;
export const IconMessages = (props: TablerIconProps) => <TablerIcon {...props} name="messages" />;
export const IconMinus = (props: TablerIconProps) => <TablerIcon {...props} name="minus" />;
export const IconMoon = (props: TablerIconProps) => <TablerIcon {...props} name="moon" />;
export const IconNetwork = (props: TablerIconProps) => <TablerIcon {...props} name="network" />;
export const IconPencil = (props: TablerIconProps) => <TablerIcon {...props} name="pencil" />;
export const IconPin = (props: TablerIconProps) => <TablerIcon {...props} name="pin" />;
export const IconPlug = (props: TablerIconProps) => <TablerIcon {...props} name="plug" />;
export const IconPlus = (props: TablerIconProps) => <TablerIcon {...props} name="plus" />;
export const IconRefresh = (props: TablerIconProps) => <TablerIcon {...props} name="refresh" />;
export const IconRotate = (props: TablerIconProps) => <TablerIcon {...props} name="rotate" />;
export const IconRotateClockwise = (props: TablerIconProps) => <TablerIcon {...props} name="rotate-clockwise" />;
export const IconRoute = (props: TablerIconProps) => <TablerIcon {...props} name="route" />;
export const IconSchool = (props: TablerIconProps) => <TablerIcon {...props} name="school" />;
export const IconSearch = (props: TablerIconProps) => <TablerIcon {...props} name="search" />;
export const IconSearchOff = (props: TablerIconProps) => <TablerIcon {...props} name="search-off" />;
export const IconServer = (props: TablerIconProps) => <TablerIcon {...props} name="server" />;
export const IconServerOff = (props: TablerIconProps) => <TablerIcon {...props} name="server-off" />;
export const IconSettings = (props: TablerIconProps) => <TablerIcon {...props} name="settings" />;
export const IconShieldCheck = (props: TablerIconProps) => <TablerIcon {...props} name="shield-check" />;
export const IconShieldExclamation = (props: TablerIconProps) => <TablerIcon {...props} name="shield-exclamation" />;
export const IconShieldX = (props: TablerIconProps) => <TablerIcon {...props} name="shield-x" />;
export const IconSparkles = (props: TablerIconProps) => <TablerIcon {...props} name="sparkles" />;
export const IconSquare = (props: TablerIconProps) => <TablerIcon {...props} name="square" />;
export const IconSun = (props: TablerIconProps) => <TablerIcon {...props} name="sun" />;
export const IconTerminal2 = (props: TablerIconProps) => <TablerIcon {...props} name="terminal-2" />;
export const IconTrash = (props: TablerIconProps) => <TablerIcon {...props} name="trash" />;
export const IconUser = (props: TablerIconProps) => <TablerIcon {...props} name="user" />;
export const IconWorld = (props: TablerIconProps) => <TablerIcon {...props} name="world" />;
export const IconX = (props: TablerIconProps) => <TablerIcon {...props} name="x" />;

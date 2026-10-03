import { createContext } from 'react';

/**
 * Whether the open session still has older rows to show above the ones on screen (more history on the server, or
 * loaded rows outside the render window). Provided by WorkbenchTranscript around its prelude and read by
 * WorkbenchHandoffPrelude, which waits until the open session is shown from its first row before it draws the
 * earlier stretches above it, so the conversation reads in order and only one pager answers a scroll to the top.
 * Defaults to false: the DeepSeek view loads its conversation whole.
 */
export const WorkbenchSessionHistoryContext = createContext<{ olderRowsPending: boolean }>({ olderRowsPending: false });

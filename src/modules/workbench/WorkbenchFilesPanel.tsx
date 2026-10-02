import type { CodeEditorFile, DirectoryRevealRequest, Project } from '@/shared/types';
import { CodeEditor } from '@/modules/code-editor';
import { FileTree } from '@/modules/file-tree';

/**
 * Used by the workbench inspector's 文件 panel: the project's file tree, and the code editor in its place once a
 * file opens (from the tree, a chat link or the Git panel). Closing the editor returns to the tree as it was.
 */
export function WorkbenchFilesPanel({ project, editingFile, revealDirectory, expanded, onOpenFile, onCloseEditor, onUnsavedChangesChange, onToggleExpand }: {
  project: Project;
  editingFile: CodeEditorFile | null;
  revealDirectory: DirectoryRevealRequest | null;
  expanded: boolean;
  onOpenFile: (path: string) => void;
  onCloseEditor: () => void;
  onUnsavedChangesChange: (hasUnsavedChanges: boolean) => void;
  onToggleExpand: () => void;
}) {
  return <div className="wb-files">
    {/* The tree stays mounted under the editor so expanded folders and scroll survive opening a file. */}
    <div className="wb-files-tree" hidden={Boolean(editingFile)}>
      <FileTree selectedProject={project} onFileOpen={onOpenFile} revealDirectory={revealDirectory} />
    </div>
    {editingFile && <div className="wb-files-editor">
      <CodeEditor file={editingFile} onClose={onCloseEditor} onUnsavedChangesChange={onUnsavedChangesChange} projectPath={project.fullPath}
        isSidebar isExpanded={expanded} onToggleExpand={onToggleExpand} onPopOut={null} />
    </div>}
  </div>;
}

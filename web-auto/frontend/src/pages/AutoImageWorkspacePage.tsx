import { useRef } from 'react';
import { ImageWorkspaceShell } from './ImageWorkspaceShell';
import type { ImageViewerHandle } from '../components/viewer/ImageViewer';
import { AutoAnnotatePanel } from '../components/workspace/AutoAnnotatePanel';

/** Automatic annotation workspace: inference controls with read-only annotations. */
export function AutoImageWorkspacePage() {
  const viewerRef = useRef<ImageViewerHandle | null>(null);
  return <ImageWorkspaceShell mode="auto" viewerRef={viewerRef} modePanel={<AutoAnnotatePanel />} />;
}

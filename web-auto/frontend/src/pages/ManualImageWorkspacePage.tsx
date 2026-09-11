import { useRef } from 'react';
import { ImageWorkspaceShell } from './ImageWorkspaceShell';
import type { ImageViewerHandle } from '../components/viewer/ImageViewer';
import { useManualWorkspaceController } from '../hooks/useManualWorkspaceController';
import { ReviewToolbar } from '../components/workspace/ReviewToolbar';

/** Manual annotation workspace: geometry editing and AI-assisted point prompts. */
export function ManualImageWorkspacePage() {
  const viewerRef = useRef<ImageViewerHandle | null>(null);
  const manual = useManualWorkspaceController(viewerRef);
  return <ImageWorkspaceShell mode="review" viewerRef={viewerRef} manual={manual} modePanel={<ReviewToolbar />} />;
}

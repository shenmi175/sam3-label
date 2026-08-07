import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '@mui/material/styles';
import type { Annotation, PreviewInfo, Prompt, TileInfo } from '../../api/types';
import { ImageViewerCore } from './viewer-core';
import type {
  AnnotationCreatedHandler,
  AnnotationEditStartHandler,
  AnnotationSelectedHandler,
  AnnotationUpdatedHandler,
  ImageBbox,
  ImageSize,
  PromptAddedHandler,
  PromptMode,
  ViewerOptions,
} from './viewer-core';

export type { PromptMode } from './viewer-core';

/** Imperative handle exposed by {@link ImageViewer}. */
export interface ImageViewerHandle {
  fitToScreen(): void;
  centerOn(bbox: [number, number, number, number]): void;
  zoomBy(factor: number): void;
  panByPixels(dx: number, dy: number): void;
  finishManualPolygon(): void;
  cancelManualPolygon(): void;
  requestDraw(): void;
  onResize(): void;
  getImageSize(): { width: number; height: number } | null;
}

export interface ImageViewerProps {
  tileInfo?: TileInfo | null;
  previewInfo?: PreviewInfo | null;
  annotations?: Annotation[];
  previews?: Annotation[];
  prompts?: Prompt[];
  promptMode?: PromptMode;
  boxPromptLabel?: 0 | 1;
  focusedAnnotationId?: string | null;
  options?: ViewerOptions | Record<string, unknown>;
  onPromptAdded?: PromptAddedHandler;
  onAnnotationSelected?: AnnotationSelectedHandler;
  onAnnotationEditStart?: AnnotationEditStartHandler;
  onAnnotationUpdated?: AnnotationUpdatedHandler;
  onAnnotationCreated?: AnnotationCreatedHandler;
  className?: string;
  style?: CSSProperties;
}

interface CallbackBundle {
  onPromptAdded?: PromptAddedHandler;
  onAnnotationSelected?: AnnotationSelectedHandler;
  onAnnotationEditStart?: AnnotationEditStartHandler;
  onAnnotationUpdated?: AnnotationUpdatedHandler;
  onAnnotationCreated?: AnnotationCreatedHandler;
}

/**
 * React wrapper around {@link ImageViewerCore} (the 1:1 TypeScript port of the
 * legacy ImageViewerV2 canvas). The core instance is created once on mount and
 * destroyed on unmount; every prop is forwarded through a dedicated effect and
 * callbacks are kept in a ref so listener wiring never re-runs.
 */
export const ImageViewer = forwardRef<ImageViewerHandle, ImageViewerProps>(function ImageViewer(
  {
    tileInfo,
    previewInfo,
    annotations,
    previews,
    prompts,
    promptMode,
    boxPromptLabel,
    focusedAnnotationId,
    options,
    onPromptAdded,
    onAnnotationSelected,
    onAnnotationEditStart,
    onAnnotationUpdated,
    onAnnotationCreated,
    className,
    style,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<ImageViewerCore | null>(null);
  const theme = useTheme();

  // Theme-aware canvas background (legacy css/index.css --canvas-bg: light
  // #eaeff2 / dark #1b1e26). Applied whenever the palette mode changes.
  const canvasBackground = theme.palette.mode === 'dark' ? '#1b1e26' : '#eaeff2';
  useEffect(() => {
    coreRef.current?.setBackground(canvasBackground);
  }, [canvasBackground]);

  // Latest callback props, kept in a ref so the core's listeners never need rebinding.
  const callbacksRef = useRef<CallbackBundle>({
    onPromptAdded,
    onAnnotationSelected,
    onAnnotationEditStart,
    onAnnotationUpdated,
    onAnnotationCreated,
  });
  useEffect(() => {
    callbacksRef.current = {
      onPromptAdded,
      onAnnotationSelected,
      onAnnotationEditStart,
      onAnnotationUpdated,
      onAnnotationCreated,
    };
  }, [onPromptAdded, onAnnotationSelected, onAnnotationEditStart, onAnnotationUpdated, onAnnotationCreated]);

  // Create the core exactly once; destroy it on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const core = new ImageViewerCore(container);
    core.onPromptAdded = (type, data) => callbacksRef.current.onPromptAdded?.(type, data);
    core.onAnnotationSelected = (annotationId) => callbacksRef.current.onAnnotationSelected?.(annotationId);
    core.onAnnotationEditStart = (annotation) => callbacksRef.current.onAnnotationEditStart?.(annotation);
    core.onAnnotationUpdated = (annotation, info) => callbacksRef.current.onAnnotationUpdated?.(annotation, info);
    core.onAnnotationCreated = (draft) => callbacksRef.current.onAnnotationCreated?.(draft);
    coreRef.current = core;
    return () => {
      core.destroy();
      coreRef.current = null;
    };
  }, []);

  // Prop forwarding: one effect per prop, dependency arrays keep the original references.
  useEffect(() => {
    coreRef.current?.setImageSource(tileInfo ?? null);
  }, [tileInfo]);

  useEffect(() => {
    coreRef.current?.setPreviewSource(previewInfo ?? null);
  }, [previewInfo]);

  useEffect(() => {
    coreRef.current?.setAnnotations(annotations ?? []);
  }, [annotations]);

  useEffect(() => {
    coreRef.current?.setPreviews(previews ?? []);
  }, [previews]);

  useEffect(() => {
    coreRef.current?.setPrompts(prompts ?? []);
  }, [prompts]);

  useEffect(() => {
    coreRef.current?.setPromptMode(promptMode ?? 'none');
  }, [promptMode]);

  useEffect(() => {
    coreRef.current?.setBoxPromptLabel(boxPromptLabel ?? 1);
  }, [boxPromptLabel]);

  useEffect(() => {
    coreRef.current?.setFocusedAnnotation(focusedAnnotationId ?? null);
  }, [focusedAnnotationId]);

  useEffect(() => {
    coreRef.current?.setOptions(options ?? {});
  }, [options]);

  // Automatic resize handling via ResizeObserver.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      coreRef.current?.onResize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fitToScreen: () => {
        coreRef.current?.fitToScreen();
      },
      centerOn: (bbox: ImageBbox) => {
        coreRef.current?.centerOn(bbox);
      },
      zoomBy: (factor: number) => {
        coreRef.current?.zoomBy(factor);
      },
      panByPixels: (dx: number, dy: number) => {
        coreRef.current?.panByPixels(dx, dy);
      },
      finishManualPolygon: () => {
        coreRef.current?.finishManualPolygon();
      },
      cancelManualPolygon: () => {
        coreRef.current?.cancelManualPolygon();
      },
      requestDraw: () => {
        coreRef.current?.requestDraw();
      },
      onResize: () => {
        coreRef.current?.onResize();
      },
      getImageSize: (): ImageSize | null => coreRef.current?.getImageSize() ?? null,
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%', ...style }}
    />
  );
});

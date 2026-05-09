import { useEffect, useRef, useState } from "react";

import { VisualRuntimeVector3 } from "../../../shared/src/world_contracts";
import {
  VisualRobotWorldScene,
  VisualRuntimeRenderMetrics,
} from "../scene/robotWorldScene";

const initialMetrics: VisualRuntimeRenderMetrics = {
  fps: 0,
  frameTimeMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  canvasWidth: 0,
  canvasHeight: 0,
};

interface RobotWorldViewerProps {
  readonly executionPath?: readonly VisualRuntimeVector3[];
  readonly executionRunId?: string;
}

export const RobotWorldViewer = ({ executionPath, executionRunId }: RobotWorldViewerProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<VisualRobotWorldScene | null>(null);
  const [metrics, setMetrics] = useState<VisualRuntimeRenderMetrics>(initialMetrics);

  useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const scene = new VisualRobotWorldScene({
      host: hostRef.current,
      onMetrics: setMetrics,
    });
    sceneRef.current = scene;
    const resizeObserver = new ResizeObserver(scene.resize);
    resizeObserver.observe(hostRef.current);

    return () => {
      resizeObserver.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (executionPath && executionRunId) {
      sceneRef.current?.setDemoExecutionPath(executionPath, executionRunId);
    }
  }, [executionPath, executionRunId]);

  return (
    <div className="robot-viewer-shell" data-vr05-viewer="ready" data-vr06-viewer="ready">
      <div ref={hostRef} className="robot-viewer-canvas-host" />
      <div className="render-metrics" aria-label="Render performance metrics">
        <span data-render-metric="fps">{metrics.fps} fps</span>
        <span data-render-metric="frame-time">{metrics.frameTimeMs} ms</span>
        <span data-render-metric="draw-calls">{metrics.drawCalls} calls</span>
        <span data-render-metric="triangles">{metrics.triangles} tris</span>
        <span data-render-metric="memory">
          {metrics.geometries} geo / {metrics.textures} tex
        </span>
      </div>
    </div>
  );
};

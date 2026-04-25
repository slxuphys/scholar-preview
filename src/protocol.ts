export type CellKind = "markdown" | "code";

export interface CellSnapshot {
  id: string;
  index: number;
  kind: CellKind;
  language: string;
  source: string;
  outputs: OutputSnapshot[];
}

export interface OutputSnapshot {
  mime: string;
  text?: string;
  dataUri?: string;
}

export interface NotebookSnapshot {
  docVersion: number;
  activeCellId?: string;
  cellOrder: string[];
  cells: Record<string, CellSnapshot>;
}

export type PatchOp =
  | {
      type: "insertCells";
      at: number;
      cells: CellSnapshot[];
    }
  | {
      type: "deleteCells";
      ids: string[];
    }
  | {
      type: "moveCells";
      ids: string[];
      to: number;
    }
  | {
      type: "recordCellSnapshot";
      id: string;
      cell: CellSnapshot;
    }
  | {
      type: "setActiveCell";
      id?: string;
    };

export type HostToWebviewMessage =
  | {
      type: "fullSync";
      snapshot: NotebookSnapshot;
    }
  | {
      type: "patch";
      baseVersion: number;
      docVersion: number;
      ops: PatchOp[];
    }
  | {
      type: "status";
      text: string;
    };

export type WebviewToHostMessage =
  | {
      type: "requestFullSync";
    }
  | {
      type: "focusCell";
      id: string;
    }
  | {
      type: "toggleFollowActiveCell";
    }
  | {
      type: "ack";
      docVersion: number;
    };

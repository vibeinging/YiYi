import { describe, it, expect } from "vitest";
import type {
  CanvasEvent,
  CanvasComponent,
  CardComponent,
  StatusComponent,
  TableComponent,
  ActionsComponent,
  ListComponent,
  FormComponent,
  CanvasActionHandler,
} from "./canvas";

// canvas.ts is a pure-types module — no invoke() wrappers. These tests lock
// down the structural shape so accidental field renames / type drift are
// caught at build time (the file must typecheck) and so fixtures used by
// renderer components remain valid at runtime.

describe("canvas api (types)", () => {
  describe("CanvasEvent", () => {
    it("accepts a minimal shape with no components", () => {
      const evt: CanvasEvent = {
        canvas_id: "c1",
        session_id: "s1",
        components: [],
      };
      expect(evt.canvas_id).toBe("c1");
      expect(evt.session_id).toBe("s1");
      expect(evt.components).toEqual([]);
    });

    it("accepts an optional title", () => {
      const evt: CanvasEvent = {
        canvas_id: "c1",
        session_id: "s1",
        title: "Hello",
        components: [],
      };
      expect(evt.title).toBe("Hello");
    });
  });

  describe("CardComponent", () => {
    it("supports minimal shape (type + title)", () => {
      const card: CardComponent = { type: "card", title: "T" };
      expect(card.type).toBe("card");
      expect(card.title).toBe("T");
    });

    it("supports the full optional surface", () => {
      const card: CardComponent = {
        type: "card",
        id: "card-1",
        title: "T",
        description: "D",
        image: "https://x/y.png",
        accent: "#f00",
        tags: ["a", "b"],
        footer: "F",
      };
      expect(card.tags).toEqual(["a", "b"]);
    });
  });

  describe("StatusComponent", () => {
    it("carries an array of status steps with all status values", () => {
      const status: StatusComponent = {
        type: "status",
        steps: [
          { label: "a", status: "pending" },
          { label: "b", status: "running", detail: "50%" },
          { label: "c", status: "done" },
          { label: "d", status: "error" },
        ],
      };
      expect(status.steps).toHaveLength(4);
      expect(status.steps[1].detail).toBe("50%");
    });
  });

  describe("TableComponent", () => {
    it("has headers and rows of unknown cells", () => {
      const table: TableComponent = {
        type: "table",
        headers: ["name", "age"],
        rows: [
          ["alice", 30],
          ["bob", 25],
        ],
      };
      expect(table.headers).toEqual(["name", "age"]);
      expect(table.rows).toHaveLength(2);
    });
  });

  describe("ActionsComponent", () => {
    it("requires an id and a buttons array with each action variant", () => {
      const actions: ActionsComponent = {
        type: "actions",
        id: "actions-1",
        buttons: [
          { label: "Go", action: "go", variant: "primary" },
          { label: "Cancel", action: "cancel", variant: "secondary" },
          { label: "Delete", action: "delete", variant: "danger" },
          { label: "Plain", action: "plain" },
        ],
      };
      expect(actions.buttons).toHaveLength(4);
      expect(actions.buttons[0].variant).toBe("primary");
      expect(actions.buttons[3].variant).toBeUndefined();
    });
  });

  describe("ListComponent", () => {
    it("carries items with title and optional metadata", () => {
      const list: ListComponent = {
        type: "list",
        items: [
          { title: "item 1", subtitle: "sub", icon: "star", badge: "new" },
          { title: "item 2" },
        ],
      };
      expect(list.items[0].subtitle).toBe("sub");
      expect(list.items[1].badge).toBeUndefined();
    });
  });

  describe("FormComponent", () => {
    it("supports all field_type values and required/placeholder/options", () => {
      const form: FormComponent = {
        type: "form",
        id: "form-1",
        title: "Profile",
        fields: [
          { name: "a", label: "A", field_type: "text", required: true },
          { name: "b", label: "B", field_type: "email" },
          { name: "c", label: "C", field_type: "number", placeholder: "0" },
          {
            name: "d",
            label: "D",
            field_type: "select",
            options: ["x", "y"],
          },
          { name: "e", label: "E", field_type: "textarea" },
          { name: "f", label: "F", field_type: "toggle" },
        ],
      };
      expect(form.fields).toHaveLength(6);
      expect(form.fields[3].options).toEqual(["x", "y"]);
    });
  });

  describe("CanvasComponent discriminated union", () => {
    it("lets callers narrow by .type", () => {
      const components: CanvasComponent[] = [
        { type: "card", title: "c" },
        { type: "status", steps: [] },
        { type: "table", headers: [], rows: [] },
        { type: "actions", id: "a", buttons: [] },
        { type: "list", items: [] },
        { type: "form", id: "f", title: "t", fields: [] },
      ];
      const types = components.map((c) => c.type);
      expect(types).toEqual([
        "card",
        "status",
        "table",
        "actions",
        "list",
        "form",
      ]);
    });
  });

  describe("CanvasActionHandler", () => {
    it("accepts the documented callback signature and receives all args", () => {
      const calls: Array<[string, string, string, unknown]> = [];
      const handler: CanvasActionHandler = (canvasId, componentId, action, value) => {
        calls.push([canvasId, componentId, action, value]);
      };
      handler("c1", "btn-1", "submit", { name: "alice" });
      handler("c1", "btn-2", "cancel");
      expect(calls).toEqual([
        ["c1", "btn-1", "submit", { name: "alice" }],
        ["c1", "btn-2", "cancel", undefined],
      ]);
    });
  });
});

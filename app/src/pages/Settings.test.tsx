import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { ToastProvider } from "../components/Toast";
import { SettingsPage } from "./Settings";
import type { MemmeConfig } from "../api/system";
import type { ActiveModelsInfo } from "../api/models";

const invokeMock = invoke as unknown as Mock;

function makeMemmeConfig(overrides: Partial<MemmeConfig> = {}): MemmeConfig {
  return {
    embedding_provider: "local-bge-zh",
    embedding_model: "bge-small-zh-v1.5",
    embedding_api_key: "",
    embedding_base_url: "",
    embedding_dims: 512,
    enable_graph: true,
    enable_forgetting_curve: true,
    extraction_depth: "standard",
    memory_llm_base_url: "",
    memory_llm_api_key: "",
    memory_llm_model: "",
    ...overrides,
  };
}

// The Settings page commands that fire on memory-tab mount:
//   get_memme_config   (via getMemmeConfig)
//   get_active_llm     (via getActiveLlm)
//   save_memme_config  (via saveMemmeConfig) — dirty-save and one-click preset
// Additionally, the general useEffect fires get_user_workspace on any mount.
function mountRoutes(overrides: Record<string, (args?: any) => unknown> = {}) {
  return {
    get_user_workspace: () => "/Users/test/Documents/YiYi",
    get_memme_config: () => makeMemmeConfig(),
    get_active_llm: (): ActiveModelsInfo => ({
      provider_id: null,
      model: null,
    }),
    save_memme_config: () => ({ llm_hot_swapped: false, warning: null }),
    ...overrides,
  };
}

function renderPage() {
  // Force the memory tab to be active on mount. Settings.tsx reads this key
  // in a useEffect and switches activeTab before the first paint.
  sessionStorage.setItem("settings_pending_tab", "memory");
  return render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>,
  );
}

describe("SettingsPage — memory tab", () => {
  beforeEach(() => {
    mockInvoke(mountRoutes());
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("renders the BGE embedding info card when the memory tab is active", async () => {
    renderPage();
    // Wait for the activeTab switch + memory-tab mount commands to settle.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_memme_config");
      expect(invokeMock).toHaveBeenCalledWith("get_active_llm");
    });
    // The embedding card has the model id as a <span class="font-mono">.
    expect(await screen.findByText("bge-small-zh-v1.5")).toBeInTheDocument();
    // And the 512-dim description.
    expect(
      screen.getByText(/512 维 · 本地 ONNX/),
    ).toBeInTheDocument();
  });

  it("shows the '一键填入' quick-apply button when the active provider matches a preset", async () => {
    mockInvoke(
      mountRoutes({
        get_active_llm: (): ActiveModelsInfo => ({
          provider_id: "openai",
          model: "gpt-4o-mini",
        }),
      }),
    );
    renderPage();
    // Hint card shows the preset label ("OpenAI") and model.
    expect(await screen.findByText(/OpenAI/)).toBeInTheDocument();
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /一键填入/ }),
    ).toBeInTheDocument();
  });

  it("calls save_memme_config with the preset values when '一键填入' is clicked", async () => {
    const user = userEvent.setup();
    const captured: { config: MemmeConfig | null } = { config: null };
    mockInvoke(
      mountRoutes({
        get_active_llm: (): ActiveModelsInfo => ({
          provider_id: "openai",
          model: "gpt-4o-mini",
        }),
        save_memme_config: ({ config }: any) => {
          captured.config = config as MemmeConfig;
          return { llm_hot_swapped: true, warning: null };
        },
      }),
    );
    renderPage();
    const applyBtn = await screen.findByRole("button", { name: /一键填入/ });
    await user.click(applyBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_memme_config",
        expect.objectContaining({
          config: expect.objectContaining({
            memory_llm_base_url:
              "https://api.openai.com/v1/chat/completions",
            memory_llm_model: "gpt-4o-mini",
          }),
        }),
      );
    });
    expect(captured.config?.memory_llm_model).toBe("gpt-4o-mini");
    // After the save, the button transitions to "已填入" (disabled state).
    expect(
      await screen.findByRole("button", { name: /已填入/ }),
    ).toBeDisabled();
  });

  it("disables the LLM save button by default and enables it after editing a field", async () => {
    const user = userEvent.setup();
    renderPage();
    // Wait for memory tab to mount and config to load.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_memme_config");
    });
    // The per-card Save button at bottom of the LLM card.
    const saveBtns = await screen.findAllByRole("button", { name: /^保存$/ });
    const saveBtn = saveBtns[saveBtns.length - 1];
    expect(saveBtn).toBeDisabled();

    // Edit the base_url input (first text input in the LLM field block).
    const baseUrlInput = screen.getByPlaceholderText(
      "https://api.openai.com/v1/chat/completions",
    );
    await user.type(baseUrlInput, "https://custom.example.com/v1/chat/completions");

    // Now llmDirty is true and save is enabled.
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
  });

  it("persists LLM edits via save_memme_config when the per-card Save is clicked", async () => {
    const user = userEvent.setup();
    const captured: { config: MemmeConfig | null } = { config: null };
    mockInvoke(
      mountRoutes({
        save_memme_config: ({ config }: any) => {
          captured.config = config as MemmeConfig;
          return { llm_hot_swapped: false, warning: null };
        },
      }),
    );
    renderPage();
    // Wait for mount effects.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_memme_config");
    });

    const modelInput = screen.getByPlaceholderText("gpt-4o-mini");
    await user.type(modelInput, "qwen-turbo");

    const saveBtns = screen.getAllByRole("button", { name: /^保存$/ });
    const saveBtn = saveBtns[saveBtns.length - 1];
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_memme_config",
        expect.objectContaining({
          config: expect.objectContaining({
            memory_llm_model: "qwen-turbo",
          }),
        }),
      );
    });
    expect(captured.config?.memory_llm_model).toBe("qwen-turbo");
  });
});

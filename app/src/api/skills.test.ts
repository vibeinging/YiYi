import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listSkills,
  getSkill,
  getSkillContent,
  enableSkill,
  disableSkill,
  createSkill,
  updateSkill,
  importSkill,
  reloadSkills,
  hubSearchSkills,
  hubListSkills,
  hubInstallSkill,
  getHubConfig,
  generateSkillAI,
  type Skill,
  type HubSkill,
  type HubConfig,
  type HubInstallResult,
} from "./skills";

const invokeMock = invoke as unknown as Mock;
const listenMock = listen as unknown as Mock;

describe("skills api", () => {
  const baseSkill: Skill = {
    name: "demo",
    description: "a demo skill",
  };

  describe("listSkills", () => {
    it("invokes list_skills with { source, enabledOnly } when options supplied", async () => {
      mockInvoke({ list_skills: () => [baseSkill] });
      const result = await listSkills({ source: "builtin", enabledOnly: true });
      expect(result).toEqual([baseSkill]);
      expect(invokeMock).toHaveBeenCalledWith("list_skills", {
        source: "builtin",
        enabledOnly: true,
      });
    });

    it("passes undefined for omitted options", async () => {
      mockInvoke({ list_skills: () => [] });
      await listSkills();
      expect(invokeMock).toHaveBeenCalledWith("list_skills", {
        source: undefined,
        enabledOnly: undefined,
      });
    });

    it("parses YAML frontmatter and merges fields into the skill", async () => {
      const skillWithFm: Skill = {
        name: "demo",
        description: "",
        content: [
          "---",
          'description: parsed desc',
          'author: "jane"',
          'version: 1.2.3',
          'homepage: https://example.com',
          '"emoji": "🎨"',
          "tags:",
          "  - a",
          "  - b",
          "---",
          "body",
        ].join("\n"),
      };
      mockInvoke({ list_skills: () => [skillWithFm] });
      const [parsed] = await listSkills();
      expect(parsed.description).toBe("parsed desc");
      expect(parsed.author).toBe("jane");
      expect(parsed.version).toBe("1.2.3");
      expect(parsed.url).toBe("https://example.com");
      expect(parsed.emoji).toBe("🎨");
      expect(parsed.tags).toEqual(["a", "b"]);
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_skills: () => {
          throw new Error("db offline");
        },
      });
      await expect(listSkills()).rejects.toThrow("db offline");
    });
  });

  describe("getSkill", () => {
    it("invokes get_skill with { name } and returns the skill", async () => {
      mockInvoke({ get_skill: () => baseSkill });
      const result = await getSkill("demo");
      expect(result).toEqual(baseSkill);
      expect(invokeMock).toHaveBeenCalledWith("get_skill", { name: "demo" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_skill: () => {
          throw new Error("not found");
        },
      });
      await expect(getSkill("missing")).rejects.toThrow("not found");
    });
  });

  describe("getSkillContent", () => {
    it("invokes get_skill_content with { name, file_path } (snake_case file_path)", async () => {
      mockInvoke({ get_skill_content: () => "# body" });
      const result = await getSkillContent("demo", "references/foo.md");
      expect(result).toBe("# body");
      expect(invokeMock).toHaveBeenCalledWith("get_skill_content", {
        name: "demo",
        file_path: "references/foo.md",
      });
    });

    it("passes file_path: undefined when omitted", async () => {
      mockInvoke({ get_skill_content: () => "body" });
      await getSkillContent("demo");
      expect(invokeMock).toHaveBeenCalledWith("get_skill_content", {
        name: "demo",
        file_path: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_skill_content: () => {
          throw new Error("io error");
        },
      });
      await expect(getSkillContent("demo")).rejects.toThrow("io error");
    });
  });

  describe("enableSkill", () => {
    it("invokes enable_skill with { name } and returns a status object", async () => {
      mockInvoke({ enable_skill: () => ({ status: "ok" }) });
      const result = await enableSkill("demo");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("enable_skill", { name: "demo" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        enable_skill: () => {
          throw new Error("cannot enable");
        },
      });
      await expect(enableSkill("demo")).rejects.toThrow("cannot enable");
    });
  });

  describe("disableSkill", () => {
    it("invokes disable_skill with { name }", async () => {
      mockInvoke({ disable_skill: () => ({ status: "ok" }) });
      const result = await disableSkill("demo");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("disable_skill", { name: "demo" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        disable_skill: () => {
          throw new Error("system skill");
        },
      });
      await expect(disableSkill("demo")).rejects.toThrow("system skill");
    });
  });

  describe("createSkill", () => {
    it("invokes create_skill with full arg shape", async () => {
      mockInvoke({ create_skill: () => ({ status: "ok" }) });
      const refs = { "foo.md": "bar" };
      const scripts = { "run.sh": "echo hi" };
      const result = await createSkill("demo", "# body", refs, scripts);
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("create_skill", {
        name: "demo",
        content: "# body",
        references: refs,
        scripts: scripts,
      });
    });

    it("passes references/scripts as undefined when omitted", async () => {
      mockInvoke({ create_skill: () => ({ status: "ok" }) });
      await createSkill("demo", "# body");
      expect(invokeMock).toHaveBeenCalledWith("create_skill", {
        name: "demo",
        content: "# body",
        references: undefined,
        scripts: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_skill: () => {
          throw new Error("already exists");
        },
      });
      await expect(createSkill("demo", "x")).rejects.toThrow("already exists");
    });
  });

  describe("updateSkill", () => {
    it("invokes update_skill with { name, content }", async () => {
      mockInvoke({ update_skill: () => ({ status: "ok" }) });
      const result = await updateSkill("demo", "new body");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("update_skill", {
        name: "demo",
        content: "new body",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        update_skill: () => {
          throw new Error("readonly");
        },
      });
      await expect(updateSkill("demo", "x")).rejects.toThrow("readonly");
    });
  });

  describe("importSkill", () => {
    it("invokes import_skill with { url }", async () => {
      mockInvoke({
        import_skill: () => ({ status: "ok", skill: baseSkill }),
      });
      const result = await importSkill("https://x/y.zip");
      expect(result).toEqual({ status: "ok", skill: baseSkill });
      expect(invokeMock).toHaveBeenCalledWith("import_skill", {
        url: "https://x/y.zip",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        import_skill: () => {
          throw new Error("bad zip");
        },
      });
      await expect(importSkill("bad")).rejects.toThrow("bad zip");
    });
  });

  describe("reloadSkills", () => {
    it("invokes reload_skills and returns the status payload", async () => {
      mockInvoke({
        reload_skills: () => ({ status: "ok", count: 3 }),
      });
      const result = await reloadSkills();
      expect(result).toEqual({ status: "ok", count: 3 });
      expect(invokeMock).toHaveBeenCalledWith("reload_skills");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        reload_skills: () => {
          throw new Error("reload failed");
        },
      });
      await expect(reloadSkills()).rejects.toThrow("reload failed");
    });
  });

  describe("hubSearchSkills", () => {
    const hubSkill: HubSkill = {
      slug: "demo",
      name: "demo",
      description: "",
    };

    it("invokes hub_search_skills with { query, limit, hubUrl }", async () => {
      mockInvoke({ hub_search_skills: () => [hubSkill] });
      const result = await hubSearchSkills("pdf", 5, "https://hub.example");
      expect(result).toEqual([hubSkill]);
      expect(invokeMock).toHaveBeenCalledWith("hub_search_skills", {
        query: "pdf",
        limit: 5,
        hubUrl: "https://hub.example",
      });
    });

    it("defaults limit to 20 when omitted", async () => {
      mockInvoke({ hub_search_skills: () => [] });
      await hubSearchSkills("pdf");
      expect(invokeMock).toHaveBeenCalledWith("hub_search_skills", {
        query: "pdf",
        limit: 20,
        hubUrl: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        hub_search_skills: () => {
          throw new Error("hub down");
        },
      });
      await expect(hubSearchSkills("x")).rejects.toThrow("hub down");
    });
  });

  describe("hubListSkills", () => {
    it("invokes hub_list_skills with { limit, cursor, sort, hubUrl }", async () => {
      mockInvoke({
        hub_list_skills: () => ({ items: [], nextCursor: "next" }),
      });
      const result = await hubListSkills(10, "cur-1", "popular", "https://h");
      expect(result).toEqual({ items: [], nextCursor: "next" });
      expect(invokeMock).toHaveBeenCalledWith("hub_list_skills", {
        limit: 10,
        cursor: "cur-1",
        sort: "popular",
        hubUrl: "https://h",
      });
    });

    it("defaults limit to 20 and leaves other fields undefined when omitted", async () => {
      mockInvoke({
        hub_list_skills: () => ({ items: [], nextCursor: null }),
      });
      await hubListSkills();
      expect(invokeMock).toHaveBeenCalledWith("hub_list_skills", {
        limit: 20,
        cursor: undefined,
        sort: undefined,
        hubUrl: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        hub_list_skills: () => {
          throw new Error("hub down");
        },
      });
      await expect(hubListSkills()).rejects.toThrow("hub down");
    });
  });

  describe("hubInstallSkill", () => {
    const installResult: HubInstallResult = {
      name: "demo",
      enabled: true,
      source_url: "https://x/y",
    };

    it("invokes hub_install_skill with all options forwarded", async () => {
      mockInvoke({ hub_install_skill: () => installResult });
      const result = await hubInstallSkill("https://x/y", {
        version: "1.0.0",
        enable: false,
        overwrite: true,
        hubUrl: "https://hub.example",
      });
      expect(result).toEqual(installResult);
      expect(invokeMock).toHaveBeenCalledWith("hub_install_skill", {
        url: "https://x/y",
        version: "1.0.0",
        enable: false,
        overwrite: true,
        hubUrl: "https://hub.example",
      });
    });

    it("applies defaults (enable=true, overwrite=false) when options omitted", async () => {
      mockInvoke({ hub_install_skill: () => installResult });
      await hubInstallSkill("https://x/y");
      expect(invokeMock).toHaveBeenCalledWith("hub_install_skill", {
        url: "https://x/y",
        version: undefined,
        enable: true,
        overwrite: false,
        hubUrl: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        hub_install_skill: () => {
          throw new Error("install failed");
        },
      });
      await expect(hubInstallSkill("x")).rejects.toThrow("install failed");
    });
  });

  describe("getHubConfig", () => {
    it("invokes get_hub_config and returns the HubConfig", async () => {
      const cfg: HubConfig = {
        base_url: "https://hub.example",
        search_path: "/search",
        detail_path: "/detail",
        file_path: "/file",
        download_path: "/download",
        list_path: "/list",
      };
      mockInvoke({ get_hub_config: () => cfg });
      const result = await getHubConfig();
      expect(result).toEqual(cfg);
      expect(invokeMock).toHaveBeenCalledWith("get_hub_config");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_hub_config: () => {
          throw new Error("config missing");
        },
      });
      await expect(getHubConfig()).rejects.toThrow("config missing");
    });
  });

  describe("generateSkillAI", () => {
    it("subscribes to skill-gen://{chunk,complete,error} and invokes generate_skill_ai with { description }", async () => {
      mockInvoke({ generate_skill_ai: () => undefined });
      const unlisten = await generateSkillAI(
        "a skill that greets users",
        () => {},
        () => {},
        () => {},
      );
      expect(listenMock).toHaveBeenCalledWith(
        "skill-gen://chunk",
        expect.any(Function),
      );
      expect(listenMock).toHaveBeenCalledWith(
        "skill-gen://complete",
        expect.any(Function),
      );
      expect(listenMock).toHaveBeenCalledWith(
        "skill-gen://error",
        expect.any(Function),
      );
      expect(invokeMock).toHaveBeenCalledWith("generate_skill_ai", {
        description: "a skill that greets users",
      });
      expect(typeof unlisten).toBe("function");
      // unlisten should be safe to invoke (it calls the no-op unsubscribers)
      expect(() => unlisten()).not.toThrow();
    });

    it("propagates backend errors from invoke", async () => {
      mockInvoke({
        generate_skill_ai: () => {
          throw new Error("no llm");
        },
      });
      await expect(
        generateSkillAI("x", () => {}, () => {}, () => {}),
      ).rejects.toThrow("no llm");
    });
  });
});

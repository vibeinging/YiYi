import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listMCPClients,
  getMCPClient,
  createMCPClient,
  updateMCPClient,
  toggleMCPClient,
  deleteMCPClient,
  type MCPClientInfo,
  type MCPClientCreateRequest,
} from "./mcp";

const invokeMock = invoke as unknown as Mock;

describe("mcp api", () => {
  const sampleClient: MCPClientInfo = {
    key: "fs",
    name: "filesystem",
    description: "local fs access",
    enabled: true,
    transport: "stdio",
    url: "",
    headers: {},
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    env: {},
    cwd: "/tmp",
  };

  const sampleRequest: MCPClientCreateRequest = {
    name: "filesystem",
    description: "local fs access",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
  };

  describe("listMCPClients", () => {
    it("invokes list_mcp_clients and returns the client list", async () => {
      mockInvoke({ list_mcp_clients: () => [sampleClient] });
      const result = await listMCPClients();
      expect(result).toEqual([sampleClient]);
      expect(invokeMock).toHaveBeenCalledWith("list_mcp_clients");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_mcp_clients: () => {
          throw new Error("db offline");
        },
      });
      await expect(listMCPClients()).rejects.toThrow("db offline");
    });
  });

  describe("getMCPClient", () => {
    it("invokes get_mcp_client with { key } and returns the client", async () => {
      mockInvoke({ get_mcp_client: () => sampleClient });
      const result = await getMCPClient("fs");
      expect(result).toEqual(sampleClient);
      expect(invokeMock).toHaveBeenCalledWith("get_mcp_client", { key: "fs" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_mcp_client: () => {
          throw new Error("not found");
        },
      });
      await expect(getMCPClient("missing")).rejects.toThrow("not found");
    });
  });

  describe("createMCPClient", () => {
    it("invokes create_mcp_client with { clientKey, client }", async () => {
      mockInvoke({ create_mcp_client: () => sampleClient });
      const result = await createMCPClient("fs", sampleRequest);
      expect(result).toEqual(sampleClient);
      expect(invokeMock).toHaveBeenCalledWith("create_mcp_client", {
        clientKey: "fs",
        client: sampleRequest,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_mcp_client: () => {
          throw new Error("duplicate key");
        },
      });
      await expect(createMCPClient("fs", sampleRequest)).rejects.toThrow(
        "duplicate key",
      );
    });
  });

  describe("updateMCPClient", () => {
    it("invokes update_mcp_client with { key, client }", async () => {
      mockInvoke({ update_mcp_client: () => sampleClient });
      const result = await updateMCPClient("fs", sampleRequest);
      expect(result).toEqual(sampleClient);
      expect(invokeMock).toHaveBeenCalledWith("update_mcp_client", {
        key: "fs",
        client: sampleRequest,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        update_mcp_client: () => {
          throw new Error("not found");
        },
      });
      await expect(updateMCPClient("fs", sampleRequest)).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("toggleMCPClient", () => {
    it("invokes toggle_mcp_client with { key } and returns the client", async () => {
      mockInvoke({ toggle_mcp_client: () => sampleClient });
      const result = await toggleMCPClient("fs");
      expect(result).toEqual(sampleClient);
      expect(invokeMock).toHaveBeenCalledWith("toggle_mcp_client", {
        key: "fs",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        toggle_mcp_client: () => {
          throw new Error("not found");
        },
      });
      await expect(toggleMCPClient("fs")).rejects.toThrow("not found");
    });
  });

  describe("deleteMCPClient", () => {
    it("invokes delete_mcp_client with { key } and returns { message }", async () => {
      mockInvoke({ delete_mcp_client: () => ({ message: "deleted" }) });
      const result = await deleteMCPClient("fs");
      expect(result).toEqual({ message: "deleted" });
      expect(invokeMock).toHaveBeenCalledWith("delete_mcp_client", {
        key: "fs",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_mcp_client: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteMCPClient("missing")).rejects.toThrow("not found");
    });
  });
});

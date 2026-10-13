import { z } from "zod";
import type { SetupSnapshot } from "./setup.js";

export const connectionModes = ["复用已有 DSH", "由插件启动"] as const;

const fieldSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), title: z.string(), description: z.string().optional(), enum: z.array(z.string()).optional(), maxLength: z.number().optional() }),
  z.object({ type: z.literal("boolean"), title: z.string(), description: z.string().optional() }),
]);

export const settingsValuesSchema = z.object({ mode: z.enum(connectionModes), url: z.literal(""), autoArchiveSuccessfulRuns: z.boolean() });
export const settingsReadSchema = {
  schema: z.object({ type: z.literal("object"), properties: z.record(z.string(), fieldSchema) }),
  values: settingsValuesSchema,
  layout: z.array(z.object({ kind: z.literal("group"), title: z.string(), items: z.array(z.object({ kind: z.literal("property"), property: z.string() })) })),
};

export const settingsUpdateSchema = z.object({
  mode: z.enum(connectionModes).optional(),
  url: z.string().max(4096).optional(),
  autoArchiveSuccessfulRuns: z.boolean().optional(),
}).strict().refine((set) => Object.keys(set).length > 0, "At least one setting must be supplied.");

export function settingsValues(snapshot: SetupSnapshot) {
  // url 是一次编辑的输入，不是已存凭据的展示；读取和保存结果都不回显 token。
  return { mode: snapshot.mode === "managed" ? connectionModes[1] : connectionModes[0], url: "" as const, autoArchiveSuccessfulRuns: snapshot.autoArchiveSuccessfulRuns };
}

/** 提供客户端原生控件所需的字段、有效值和分组，不生成网页或发起聊天表单。 */
export function settingsDefinition(snapshot: SetupSnapshot) {
  return {
    schema: {
      type: "object" as const,
      properties: {
        mode: { type: "string" as const, title: "连接方式", enum: [...connectionModes], description: "填写新的认证 URL 后会自动连接已有 DSH 服务。" },
        url: { type: "string" as const, title: "连接或更新已有 DSH 的认证 URL", maxLength: 4096, description: `粘贴本次 dsh web 输出的完整本机地址（含 token），按 Enter 或移开焦点后验证并保存。空白不会清除旧设置；已保存凭据不回显。当前地址：${snapshot.externalWebUrl ?? "未连接已有服务"}。` },
        autoArchiveSuccessfulRuns: { type: "boolean" as const, title: "成功后自动归档", description: "自动归档插件新建的成功会话，并清理插件新建的空工作区。" },
      },
    },
    values: settingsValues(snapshot),
    layout: [{ kind: "group" as const, title: "DeepSeek Harness 连接设置", items: ["mode", "url", "autoArchiveSuccessfulRuns"].map((property) => ({ kind: "property" as const, property })) }],
  };
}

import { createContext, useContext } from "react";
import type { CpUser, Invite, Space } from "../cp";

export type ClusterCtx = {
  user: CpUser;
  spaces: Space[];
  space: Space;
  invites: Invite[];
  switchSpace: (id: string, view?: string) => void;
  takeInitialView: () => string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  keysVersion: number;
  pushKeys: () => Promise<void>;
  requestUnlock: () => void;
  toast: (m: string) => void;
};

export const Cluster = createContext<ClusterCtx | null>(null);
export const useCluster = () => useContext(Cluster);

// IPC channel names: the one list the main process and the preload share.
export const IPC = {
  getState: "ck:get-state",
  state: "ck:state",
  addPaths: "ck:add-paths",
  pickClips: "ck:pick-clips",
  pickFile: "ck:pick-file",
  pickCheckout: "ck:pick-checkout",
  setJobOptions: "ck:set-job-options",
  removeJob: "ck:remove-job",
  retryJob: "ck:retry-job",
  startQueue: "ck:start-queue",
  stopQueue: "ck:stop-queue",
  showInFolder: "ck:show-in-folder",
  setVisible: "ck:set-visible",
} as const;

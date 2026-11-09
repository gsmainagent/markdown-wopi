export function canEdit({authorized,blocked,initialSynced,pendingRecovery}){return !!authorized&&!blocked&&!!initialSynced&&!pendingRecovery;}

import WorkloadDetail from './WorkloadDetail';

// Re-export the selector/config helpers so existing imports keep working.
export {
  podMatchesSelector,
  filterPodsBySelector,
  collectConfigRefs,
  workloadStatus,
} from './WorkloadDetail';

export default function DeploymentDetail() {
  return <WorkloadDetail kind="deployment" />;
}

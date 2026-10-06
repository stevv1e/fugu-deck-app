"""Манифесты Kubernetes для одного пространства. Чистая функция — легко тестировать и проверять kubeconform."""
from __future__ import annotations

LABEL = "deck.fugu/space"


def namespace_of(space_id: str) -> str:
    return f"deck-{space_id}"


def space_manifests(space: dict, env: dict[str, str], s) -> list[dict]:
    ns = namespace_of(space["id"])
    labels = {LABEL: space["id"], "deck.fugu/kind": space["kind"], "app.kubernetes.io/part-of": "fugu-deck"}
    app_labels = {**labels, "app.kubernetes.io/name": "space"}
    env_list = [{"name": k, "value": v} for k, v in env.items() if k != "CP_PUBLIC_KEY"]
    env_list += [
        {"name": "CP_PUBLIC_KEY", "valueFrom": {"configMapKeyRef": {"name": "space-config", "key": "cp_public_key"}}},
        {"name": "DATA_DIR", "value": "/data"},
        {"name": "HTTPS_PROXY", "value": s.space_egress_proxy},
        {"name": "HTTP_PROXY", "value": s.space_egress_proxy},
        {"name": "NO_PROXY", "value": "localhost,127.0.0.1,.svc,.cluster.local"},
    ]
    pvc_spec: dict = {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": s.space_storage}}}
    if s.space_storage_class:
        pvc_spec["storageClassName"] = s.space_storage_class
    pod_spec: dict = {
        "automountServiceAccountToken": False,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 10001, "fsGroup": 10001,
                            "seccompProfile": {"type": "RuntimeDefault"}},
        "containers": [{
            "name": "space",
            "image": s.space_image,
            "imagePullPolicy": "IfNotPresent",
            "ports": [{"name": "http", "containerPort": 8000}],
            "env": env_list,
            "resources": {"requests": {"cpu": "50m", "memory": "128Mi"},
                          "limits": {"cpu": s.space_cpu_limit, "memory": s.space_memory_limit}},
            "readinessProbe": {"httpGet": {"path": "/api/health", "port": "http"}, "periodSeconds": 5},
            "livenessProbe": {"httpGet": {"path": "/api/health", "port": "http"}, "periodSeconds": 20,
                              "failureThreshold": 6},
            "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]}},
            "volumeMounts": [{"name": "data", "mountPath": "/data"}, {"name": "tmp", "mountPath": "/tmp"}],
        }],
        "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "space-data"}},
                    {"name": "tmp", "emptyDir": {"sizeLimit": "256Mi"}}],
    }
    if s.space_image_pull_secret:
        pod_spec["imagePullSecrets"] = [{"name": s.space_image_pull_secret}]

    return [
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns, "labels": {
            **labels, "pod-security.kubernetes.io/enforce": "restricted"}}},
        {"apiVersion": "v1", "kind": "ResourceQuota", "metadata": {"name": "space-quota", "namespace": ns},
         "spec": {"hard": {"pods": "3", "requests.storage": s.space_storage, "persistentvolumeclaims": "1",
                           "limits.cpu": "1", "limits.memory": "1Gi", "services.loadbalancers": "0",
                           "services.nodeports": "0"}}},
        {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "space-config", "namespace": ns, "labels": labels},
         "data": {"cp_public_key": env["CP_PUBLIC_KEY"]}},
        {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": "space-data", "namespace": ns,
                                                                             "labels": labels}, "spec": pvc_spec},
        {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "space", "namespace": ns, "labels": app_labels},
         "spec": {"replicas": 1, "strategy": {"type": "Recreate"},  # SQLite + состояние запусков: один экземпляр
                  "selector": {"matchLabels": {"app.kubernetes.io/name": "space"}},
                  "template": {"metadata": {"labels": app_labels}, "spec": pod_spec}}},
        {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "space", "namespace": ns, "labels": labels},
         "spec": {"selector": {"app.kubernetes.io/name": "space"}, "ports": [{"name": "http", "port": 8000,
                                                                               "targetPort": "http"}]}},
        # Входящий трафик — только от Traefik (kube-system) и control-plane; исходящий — только DNS и egress-прокси
        {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
         "metadata": {"name": "space-isolation", "namespace": ns},
         "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"],
                  "ingress": [{"from": [
                      {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
                       "podSelector": {"matchLabels": {"app.kubernetes.io/name": "traefik"}}},
                      {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": s.control_plane_namespace}}},
                  ], "ports": [{"port": 8000, "protocol": "TCP"}]}],
                  "egress": [
                      {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
                               "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}],
                       "ports": [{"port": 53, "protocol": "UDP"}, {"port": 53, "protocol": "TCP"}]},
                      {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "deck-egress"}}}],
                       "ports": [{"port": 3128, "protocol": "TCP"}]},
                  ]}},
        {"apiVersion": "traefik.io/v1alpha1", "kind": "Middleware",
         "metadata": {"name": "strip-space", "namespace": ns},
         "spec": {"stripPrefix": {"prefixes": [f"/s/{space['id']}"]}}},
        {"apiVersion": "traefik.io/v1alpha1", "kind": "IngressRoute",
         "metadata": {"name": "space", "namespace": ns, "labels": labels},
         "spec": {"entryPoints": [s.ingress_entrypoint],
                  "routes": [{"match": f"Host(`{s.ingress_host}`) && PathPrefix(`/s/{space['id']}/`)",
                              "kind": "Rule", "middlewares": [{"name": "strip-space"}],
                              "services": [{"name": "space", "port": 8000}]}],
                  # сертификат для хоста выпускает cert-manager для control-plane; Traefik подберёт его по SNI
                  "tls": {}}},
    ]

#!/usr/bin/env python3
"""Bounded G19 userspace/ClusterIP experiment; creates and removes only its owned namespace."""
from concurrent.futures import ThreadPoolExecutor
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import struct
import sys
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--subnet", action="store_true", help="Verify explicit target /32 routes without advertising or selecting a default exit")
SUBNET_MODE = parser.parse_args().subnet
CONTEXT = "home"
OUT = Path(__file__).resolve().parent
RUN = uuid.uuid4().hex[:12]
NS = f"hs-g19-1026-{RUN}"
OWNER = "headscale-ui.dev/g19-run"
LABELS = {OWNER: RUN, "app.kubernetes.io/part-of": "headscale-ui-g19"}
PRIVATE = OUT / f"g19-private-{RUN}"
EVENTS = OUT / f"g19-{RUN}-events.jsonl"
RESULT = OUT / f"g19-{RUN}-result.json"
START = time.monotonic()
DEADLINE = START + 420
SECRETS = []
created = False
result = {"run": RUN, "namespace": NS, "context": CONTEXT, "probeTimeoutSeconds": 5,
          "mode": "explicit-subnet" if SUBNET_MODE else "default-exit",
          "phases": [], "policyComparisons": [], "assertions": {}, "cleanup": {}}


def scrub(value):
    text = str(value)
    for secret in SECRETS:
        text = text.replace(secret, "<redacted>")
    return re.sub(r"hskey-(?:auth|api|authreq)-[\w-]+", "<redacted>", text)


def write_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


def event(kind, **data):
    entry = {"elapsedSeconds": round(time.monotonic() - START, 3), "kind": kind, **data}
    fd = os.open(EVENTS, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a") as stream:
        stream.write(scrub(json.dumps(entry, ensure_ascii=False)) + "\n")


def kube(args, *, stdin=None, timeout=25, check=True, cleanup=False):
    if not cleanup:
        remaining = int(DEADLINE - time.monotonic())
        if remaining < 3:
            raise TimeoutError("The experiment's 420-second budget has ended")
        timeout = min(timeout, remaining)
    argv = ["kubectl", "--context", CONTEXT, f"--request-timeout={timeout - 2}s", *args]
    began = time.monotonic()
    completed = subprocess.run(argv, input=stdin, text=True, capture_output=True, timeout=timeout)
    event("command", argv=argv, exit=completed.returncode,
          seconds=round(time.monotonic() - began, 3))
    if completed.returncode and any(marker in completed.stderr for marker in ["Error from server (Forbidden)", "Error from server (Unauthorized)", "You must be logged in to the server"]):
        raise PermissionError(scrub(completed.stderr[-2500:]))
    if check and completed.returncode:
        raise RuntimeError(f"Command failed ({completed.returncode}): {scrub(completed.stderr[-2500:])}")
    return completed


def ns(args, **kwargs):
    return kube(["-n", NS, *args], **kwargs)


def execute(pod, argv, **kwargs):
    return ns(["exec", "-i", pod, "-c", "main", "--", *argv], **kwargs)


def hs(argv, **kwargs):
    return execute("headscale", ["headscale", *argv], **kwargs)


def metadata(name, component=None):
    labels = dict(LABELS)
    if component:
        labels["app.kubernetes.io/component"] = component
    return {"name": name, "namespace": NS, "labels": labels}


def create_objects(items):
    ns(["create", "-f", "-"], stdin=json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))


def status(pod):
    raw = json.loads(execute(pod, ["tailscale", "status", "--json"]).stdout)
    peers = []
    for peer in (raw.get("Peer") or {}).values():
        peers.append({key: peer.get(key) for key in
                      ["ID", "HostName", "TailscaleIPs", "Online", "ExitNode", "ExitNodeOption", "CurAddr", "Relay", "Active", "LastHandshake", "TxBytes", "RxBytes"]})
    return {"BackendState": raw.get("BackendState"), "Self": {
                key: (raw.get("Self") or {}).get(key) for key in ["ID", "HostName", "TailscaleIPs"]},
            "ExitNodeStatus": raw.get("ExitNodeStatus"), "Health": raw.get("Health"), "peers": peers}


def netmap(pod):
    command = execute(pod, ["tailscale", "debug", "netmap"], check=False)
    if command.returncode:
        return {"unavailable": True, "exit": command.returncode, "diagnostic": scrub(command.stderr[-1000:])}
    raw = json.loads(command.stdout)
    # Never persist the raw netmap: it can contain private node material.
    peers = [{key: peer.get(key) for key in ["ID", "Name", "Addresses", "AllowedIPs", "PrimaryRoutes"]}
             for peer in (raw.get("Peers") or [])]
    return {"PacketFilter": raw.get("PacketFilter"), "Peers": peers,
            "SelfNode": {key: (raw.get("SelfNode") or {}).get(key) for key in
                         ["ID", "Name", "Addresses", "AllowedIPs", "PrimaryRoutes"]}}


def prefs(pod):
    raw = json.loads(execute(pod, ["tailscale", "debug", "prefs"]).stdout)
    return {key: raw.get(key) for key in
            ["RouteAll", "ExitNodeID", "ExitNodeIP", "ExitNodeAllowLANAccess", "AdvertiseRoutes", "WantRunning"]}


def snapshot():
    nodes = json.loads(hs(["nodes", "list", "--output", "json"]).stdout)
    return {"nodes": [{key: node.get(key) for key in
                       ["id", "name", "given_name", "ip_addresses", "approved_routes", "available_routes", "subnet_routes"]}
                      for node in nodes],
            "A": status("a"), "R": status("r"), "APrefs": prefs("a"), "RPrefs": prefs("r"),
            "AMap": netmap("a"), "RMap": netmap("r")}


def map_fingerprint():
    return hashlib.sha256(json.dumps([netmap("a"), netmap("r")], sort_keys=True).encode()).hexdigest()


def set_policy(name, destinations):
    # Keep the owned router peer visible while varying only the destination grant.
    policy = {"acls": [{"action": "accept", "src": ["*"],
                        "dst": [f"{result['routerTailnetIP']}:*", *destinations]}]}
    before = map_fingerprint()
    hs(["policy", "set", "--file", "/dev/stdin"], stdin=json.dumps(policy))
    # Bounded local control-plane readback; do not turn a propagation delay into a target timeout change.
    until = time.monotonic() + 8
    observed = False
    while time.monotonic() < until:
        if map_fingerprint() != before:
            observed = True
            break
        time.sleep(0.25)
    readback = hs(["policy", "get"], check=False)
    event("policy", name=name, policy=policy, mapChanged=observed,
          readbackExit=readback.returncode, readback=scrub(readback.stdout))
    return policy


def approve(enabled, prefixes=("0.0.0.0/0", "::/0")):
    wanted = set(prefixes)
    routes = ",".join(prefixes) if enabled else ""
    hs(["nodes", "approve-routes", "--identifier", str(result["routerNodeID"]), f"--routes={routes}"])
    until = time.monotonic() + 10
    while time.monotonic() < until:
        mapping = netmap("a")
        received = {prefix for peer in mapping.get("Peers", [])
                    if str(peer["ID"]) == str(result["routerNodeID"]) for prefix in (peer.get("AllowedIPs") or [])}
        ready = wanted <= received if enabled else wanted.isdisjoint(received)
        if ready:
            return
        time.sleep(0.25)
    raise AssertionError("Router netmap did not reach the requested exact-route approval state")


def request(pod, address, phase, kind, proxy=False):
    token = f"/{RUN}/{phase}/{kind}"
    url = f"http://{address}:8081{token}"
    environment = "unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY; "
    if proxy:
        environment += "export http_proxy=http://127.0.0.1:1056; export no_proxy=; "
    argv = ["sh", "-c", environment + 'exec timeout 7 wget -T 5 -S -O - "$1"', "sh", url]
    completed = execute(pod, argv, timeout=15, check=False)
    status_code = re.findall(r"HTTP/1\.[01] (\d{3})", completed.stderr)
    probe = {"pod": pod, "address": address, "port": 8081, "protocol": "HTTP/TCP/IPv4",
             "transport": "tailscaled HTTP proxy 127.0.0.1:1056" if proxy else "native socket, proxies unset",
             "token": token, "url": url, "hostHeader": f"{address}:8081", "exit": completed.returncode,
             "httpStatus": int(status_code[-1]) if status_code else None,
             "marker": f"G19_{RUN}" in completed.stdout,
             "stdout": scrub(completed.stdout), "stderr": scrub(completed.stderr)}
    event("probe", phase=phase, **probe)
    return probe


def peer_request(phase):
    # Reuse tag-lifecycle.httpProbe's GET / + DNS Host contract and retain stdin until the response closes.
    argv = ["kubectl", "--context", CONTEXT, "--request-timeout=12s", "-n", NS, "exec", "-i", "a", "-c", "main", "--",
            "timeout", "5", "tailscale", "nc", result["routerTailnetIP"], "8081"]
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        child.stdin.write(f"GET / HTTP/1.1\r\nHost: {result['routerServeHost']}\r\nConnection: close\r\n\r\n")
        child.stdin.flush()
        with ThreadPoolExecutor(max_workers=2) as pool:
            output = pool.submit(child.stdout.read)
            errors = pool.submit(child.stderr.read)
            code = child.wait(timeout=12)
            response, diagnostic = output.result(), errors.result()
    finally:
        child.stdin.close()
        if child.poll() is None:
            child.kill()
            child.wait()
    match = re.search(r"^HTTP/1\.[01] (\d{3})", response)
    probe = {"pod": "a", "address": result["routerTailnetIP"], "port": 8081,
             "protocol": "HTTP/TCP/IPv4", "transport": "tailscale nc (canonical fixture peer control)",
             "hostHeader": result["routerServeHost"], "exit": code, "httpStatus": int(match[1]) if match else None,
             "marker": f"G19_{RUN}_PEER" in response, "stdout": scrub(response), "stderr": scrub(diagnostic)}
    event("peer-probe", phase=phase, **probe)
    return probe


def target_logs():
    raw = ns(["logs", "target", "-c", "main", "--tail=300"]).stdout
    entries = []
    for line in raw.splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "request" in entry:
            entries.append(entry)
    return entries


def successful(probe):
    return probe["exit"] == 0 and probe["httpStatus"] == 200 and probe["marker"]


def phase(name, targets, check_direct=False):
    before = snapshot()
    health = [request("r", address, name, f"health-{kind}") for kind, address in targets.items()]
    assert all(map(successful, health)), "R same-container target health failed"
    direct = [request("a", address, name, f"native-{kind}") for kind, address in targets.items()] if check_direct else []
    assert not any(map(successful, direct)), "A native bypass appeared during the route sequence"
    probes = [request("a", address, name, f"proxy-{kind}", proxy=True) for kind, address in targets.items()]
    after = status("a")
    after_router = status("r")
    logs = target_logs()
    for probe in probes:
        matching = [entry for entry in logs if probe["token"] in entry["request"]]
        probe["targetRecords"] = matching
        probe["sourceIsRouter"] = bool(matching) and all(entry.get("source") == result["routerPodIP"] for entry in matching)
    entry = {"name": name, "before": before, "health": health, "direct": direct, "probes": probes,
             "afterA": after, "afterR": after_router,
             "targetRecords": [entry for entry in logs if f"/{RUN}/{name}/" in entry["request"]]}
    event("phase", **entry)
    return entry


def diagnostic_capture(address):
    def metrics():
        response = execute("r", ["tailscale", "debug", "metrics"], check=False)
        return {"exit": response.returncode, "lines": [line for line in response.stdout.splitlines()
                if re.search(r"netstack|filter.*(drop|accept)|tun.*(read|write|packet)", line, re.I)]}

    before_snapshot = snapshot()
    before = metrics()
    argv = ["kubectl", "--context", CONTEXT, "-n", NS, "exec", "r", "-c", "main", "--",
            "timeout", "12", "tailscale", "debug", "capture", "--o=-"]
    capture = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        time.sleep(0.4)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = (pool.submit(peer_request, "capture-peer") if address == result["routerTailnetIP"]
                       else pool.submit(request, "a", address, "capture-open", "proxy-clusterip", True))
            time.sleep(1)
            tcp = execute("r", ["cat", "/proc/net/tcp"]).stdout
            probe = pending.result()
        raw, errors = capture.communicate(timeout=18)
    finally:
        if capture.poll() is None:
            capture.kill()
            capture.communicate()
    packets = []
    linktype = None
    magic = raw[:4]
    endian = "<" if magic in [b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1"] else ">"
    if len(raw) >= 24 and magic in [b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4", b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d"]:
        linktype = struct.unpack_from(endian + "I", raw, 20)[0]
        offset = 24
        while offset + 16 <= len(raw):
            seconds, fraction, length, original = struct.unpack_from(endian + "IIII", raw, offset)
            payload = raw[offset + 16:offset + 16 + length]
            offset += 16 + length
            for at in range(max(0, min(80, len(payload) - 39))):
                if payload[at] >> 4 != 4 or payload[at + 9] != 6:
                    continue
                ihl = (payload[at] & 15) * 4
                if ihl < 20 or at + ihl + 20 > len(payload):
                    continue
                source = str(ipaddress.ip_address(payload[at + 12:at + 16]))
                destination = str(ipaddress.ip_address(payload[at + 16:at + 20]))
                if {source, destination} != {result["clientTailnetIP"], address}:
                    continue
                source_port, destination_port = struct.unpack_from("!HH", payload, at + ihl)
                if 8081 not in [source_port, destination_port]:
                    continue
                packets.append({"seconds": seconds, "fraction": fraction, "source": source, "destination": destination,
                                "sourcePort": source_port, "destinationPort": destination_port,
                                "tcpFlags": payload[at + ihl + 13], "capturePrefixHex": payload[:at].hex()})
                break
    sockets = []
    for line in tcp.splitlines()[1:]:
        fields = line.split()
        remote, port = fields[2].split(":")
        if str(ipaddress.ip_address(bytes.fromhex(remote)[::-1])) == address and int(port, 16) == 8081:
            sockets.append({"local": fields[1], "remote": fields[2], "state": fields[3]})
    evidence = {"before": before_snapshot, "probe": probe, "routerSocketsOneSecondIntoProbe": sockets, "captureExit": capture.returncode,
                "captureBytes": len(raw), "captureLinktype": linktype, "captureDiagnostic": scrub(errors.decode(errors="replace")),
                "ownedFlowPacketHeaders": packets, "metricsBefore": before, "metricsAfter": metrics(),
                "afterA": status("a"), "afterR": status("r"), "targetRecords": target_logs()}
    event("hop-diagnostic", **evidence)
    return evidence


def run_subnet_sequence(targets):
    routes = tuple(f"{address}/32" for address in targets.values())
    wanted = set(routes)
    result.update(configuredRoutes=list(routes), chosenPolicy="original-open", defaultExitTested=False,
                  subnetForwardingPassed=False)
    execute("a", ["tailscale", "set", "--exit-node=", "--accept-routes=true"])
    source = ipaddress.ip_address(result["clientTailnetIP"])

    def filter_allows(mapping, address):
        address = ipaddress.ip_address(address)
        for rule in mapping["PacketFilter"]:
            if 6 not in rule.get("IPProto", []):
                continue
            if not any(source in ipaddress.ip_network(prefix) for prefix in rule.get("Srcs", [])):
                continue
            for destination in rule.get("Dsts", []):
                network, ports = ipaddress.ip_network(destination["Net"]), destination["Ports"]
                if network.version == address.version and address in network and ports["First"] <= 8081 <= ports["Last"]:
                    return True
        return False

    for index, (name, approved) in enumerate([("unapproved", False), ("approved", True), ("revoked", False), ("restored", True)]):
        if index:
            approve(approved, routes)
        entry = phase(f"subnet-{name}", targets, check_direct=True)
        result["phases"].append(entry)
        before = entry["before"]
        router = next(node for node in before["nodes"] if str(node["id"]) == str(result["routerNodeID"]))
        assert set(router["available_routes"] or []) == wanted
        assert set(router["approved_routes"] or []) == (wanted if approved else set())
        assert set(before["RPrefs"]["AdvertiseRoutes"] or []) == wanted
        assert before["APrefs"]["RouteAll"] and not before["APrefs"]["ExitNodeID"] and not before["APrefs"]["ExitNodeIP"]
        assert before["A"]["ExitNodeStatus"] is None
        received = {prefix for peer in before["AMap"]["Peers"]
                    if str(peer["ID"]) == str(result["routerNodeID"]) for prefix in (peer["AllowedIPs"] or [])}
        assert "0.0.0.0/0" not in received and "::/0" not in received
        route_state_matches = wanted <= received if approved else wanted.isdisjoint(received)
        assert route_state_matches
        assert all(filter_allows(before["RMap"], target) for target in targets.values())
        if approved:
            assert all(successful(probe) and probe["sourceIsRouter"] for probe in entry["probes"]), "Explicit subnet positive did not reach T from R"
        else:
            assert all(not successful(probe) and not probe["targetRecords"] for probe in entry["probes"]), "Unapproved/revoked subnet unexpectedly reached T"
        deltas = {}
        for node_name, peer_id in [("A", result["routerNodeID"]), ("R", before["A"]["Self"]["ID"])]:
            prior = next(peer for peer in before[node_name]["peers"] if str(peer["ID"]) == str(peer_id))
            after = next(peer for peer in entry[f"after{node_name}"]["peers"] if str(peer["ID"]) == str(peer_id))
            deltas[node_name] = {direction: after[counter] - prior[counter] for direction, counter in [("tx", "TxBytes"), ("rx", "RxBytes")]}
        entry["counterDeltas"] = deltas
        if approved:
            assert all(value > 0 for delta in deltas.values() for value in delta.values()), "Positive subnet flow has no bidirectional peer counter increase"
        event("subnet-stage-verified", name=entry["name"], approved=approved, routes=list(routes), counterDeltas=deltas)
    result["peerHTTPAfterSubnetSequence"] = peer_request("subnet-complete-control")
    assert successful(result["peerHTTPAfterSubnetSequence"])
    result["assertions"] = {"onlyExplicitPrivateRoutesAdvertised": True, "noDefaultRoutesOrExitSelection": True,
                            "approvalAndClientRouteSequence": True, "routerHealthAlwaysPositive": True,
                            "clientDirectAlwaysBlocked": True, "controlPacketFilterMatchesBothTargets": True,
                            "unapprovedAndRevokedFail": True, "approvedAndRestoredPassViaRouter": True,
                            "positivePeerCountersIncrease": True}
    result["subnetForwardingPassed"] = True
    result["outcome"] = "Explicit PodIP/ClusterIP /32 subnet rejection/approval/revocation/restoration passed; this is not a default-exit private pass"
    return 0


def pod(name, image, command, mounts, volumes, *, headscale=False):
    uid = 1000 if name != "target" else 101
    spec = {"automountServiceAccountToken": False, "enableServiceLinks": False,
            "hostNetwork": False, "hostPID": False, "hostIPC": False,
            "restartPolicy": "Never", "terminationGracePeriodSeconds": 3,
            "securityContext": {"runAsNonRoot": True, "runAsUser": uid, "runAsGroup": uid,
                                "fsGroup": uid, "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{"name": "main", "image": image, "command": command,
                            "securityContext": {"allowPrivilegeEscalation": False,
                                                "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                            "resources": {"requests": {"cpu": "25m", "memory": "64Mi"},
                                          "limits": {"cpu": "1", "memory": "384Mi"}},
                            "volumeMounts": mounts}], "volumes": volumes}
    container = spec["containers"][0]
    if name in ["a", "r"]:
        container["env"] = [{"name": "TS_NO_LOGS_NO_SUPPORT", "value": "true"},
                            {"name": "SSL_CERT_FILE", "value": "/fixture-ca/tls.crt"}]
        container["volumeMounts"].append({"name": "ca", "mountPath": "/fixture-ca", "readOnly": True})
        spec["volumes"].append({"name": "ca", "configMap": {"name": "headscale-ca"}})
        container["readinessProbe"] = {"exec": {"command": ["tailscale", "status", "--json"]},
                                       "periodSeconds": 1, "failureThreshold": 40}
    else:
        container["readinessProbe"] = {"httpGet": {"path": "/health" if headscale else "/", "port": 8080 if headscale else 8081},
                                       "periodSeconds": 1, "failureThreshold": 40}
    return {"apiVersion": "v1", "kind": "Pod", "metadata": metadata(name, name), "spec": spec}


def run():
    global created
    assert OUT.name == "residual-followup-2026-10-26"
    os.umask(0o077)
    PRIVATE.mkdir(mode=0o700)
    assert kube(["config", "current-context"]).stdout.strip() == CONTEXT
    assert kube(["auth", "can-i", "create", "namespaces"]).stdout.strip() == "yes"
    node = json.loads(kube(["get", "node", "my-home-server", "-o", "json"]).stdout)
    result["cluster"] = {"node": node["metadata"]["name"], "podCIDRs": node["spec"].get("podCIDRs"),
                         "kubeletVersion": node["status"]["nodeInfo"]["kubeletVersion"],
                         "runtime": node["status"]["nodeInfo"]["containerRuntimeVersion"],
                         "flannelBackend": node["metadata"]["annotations"].get("flannel.alpha.coreos.com/backend-type")}
    namespace = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": NS, "labels": LABELS}}
    kube(["create", "-f", "-"], stdin=json.dumps(namespace))
    created = True
    owned = json.loads(kube(["get", "namespace", NS, "-o", "json"]).stdout)
    assert owned["metadata"]["labels"][OWNER] == RUN
    result["namespaceUID"] = owned["metadata"]["uid"]
    for resource in ["pods", "services", "configmaps", "secrets", "networkpolicies.networking.k8s.io"]:
        assert ns(["auth", "can-i", "create", resource]).stdout.strip() == "yes", f"Cannot create {resource}"
    services = []
    for name, component, ports in [
        ("headscale", "headscale", [{"name": "control", "port": 443, "targetPort": 8443},
                                    {"name": "stun", "port": 3478, "targetPort": 3478, "protocol": "UDP"}]),
        ("target", "target", [{"name": "http", "port": 8081, "targetPort": 8081}])]:
        services.append({"apiVersion": "v1", "kind": "Service", "metadata": metadata(name, component),
                         "spec": {"type": "ClusterIP", "selector": {OWNER: RUN, "app.kubernetes.io/component": component}, "ports": ports}})
    create_objects(services)
    server_ip = json.loads(ns(["get", "service", "headscale", "-o", "json"]).stdout)["spec"]["clusterIP"]
    service_ip = json.loads(ns(["get", "service", "target", "-o", "json"]).stdout)["spec"]["clusterIP"]
    login = f"https://{server_ip}"
    certificate = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                                  "-keyout", str(PRIVATE / "tls.key"), "-out", str(PRIVATE / "tls.crt"),
                                  "-days", "1", "-subj", "/CN=headscale", "-addext", f"subjectAltName=IP:{server_ip}"],
                                 capture_output=True, text=True, timeout=15)
    assert certificate.returncode == 0, "Isolated fixture certificate generation failed"
    os.chmod(PRIVATE / "tls.key", 0o600)
    tls_key = (PRIVATE / "tls.key").read_text()
    tls_cert = (PRIVATE / "tls.crt").read_text()
    SECRETS.extend([tls_key, base64.b64encode(tls_key.encode()).decode()])
    create_objects([{"apiVersion": "v1", "kind": "Secret", "metadata": metadata("headscale-tls"), "type": "kubernetes.io/tls",
                     "data": {"tls.key": base64.b64encode(tls_key.encode()).decode(), "tls.crt": base64.b64encode(tls_cert.encode()).decode()}},
                    {"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata("headscale-ca"), "data": {"tls.crt": tls_cert}}])
    tls_proxy = ("worker_processes 1; pid /tmp/nginx.pid; error_log /dev/stderr warn; events { worker_connections 128; } "
                 "http { client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; "
                 "uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; access_log off; "
                 "server { listen 8443 ssl; ssl_certificate /fixture-tls/tls.crt; ssl_certificate_key /fixture-tls/tls.key; "
                 "location / { proxy_pass http://127.0.0.1:8080; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; "
                 "proxy_set_header Connection upgrade; proxy_read_timeout 300s; } } }")
    config = f"""server_url: {login}
listen_addr: 0.0.0.0:8080
metrics_listen_addr: \"\"
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: g19
    region_name: G19
    verify_clients: true
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
log:
  level: warn
  format: json
policy:
  mode: database
dns:
  magic_dns: false
  base_domain: g19.test
  override_local_dns: false
  nameservers:
    global: []
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: \"0770\"
logtail:
  enabled: false
taildrop:
  enabled: false
"""
    nginx = ("worker_processes 1; pid /tmp/nginx.pid; error_log /dev/stderr warn; events { worker_connections 128; }\n"
             "http { default_type text/plain; client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; "
             "fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;\n"
             "log_format g19 escape=json '{\"at\":\"$time_iso8601\",\"source\":\"$remote_addr\",\"request\":\"$request\",\"status\":$status}'; "
             f"access_log /dev/stdout g19; server {{ listen 8081; location / {{ return 200 'G19_{RUN}\\n'; }} }} }}\n")
    objects = [{"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata("headscale-config"), "data": {"config.yaml": config, "tls.conf": tls_proxy}},
               {"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata("target-config"), "data": {"nginx.conf": nginx}}]
    objects.append(pod("headscale", "headscale/headscale:0.29.4", ["headscale", "serve"],
                       [{"name": "config", "mountPath": "/etc/headscale", "readOnly": True},
                        {"name": "data", "mountPath": "/var/lib/headscale"}, {"name": "run", "mountPath": "/var/run/headscale"}],
                       [{"name": "config", "configMap": {"name": "headscale-config"}}, {"name": "data", "emptyDir": {}},
                        {"name": "run", "emptyDir": {}}], headscale=True))
    server = objects[-1]["spec"]
    server["volumes"].extend([{"name": "tls", "secret": {"secretName": "headscale-tls", "defaultMode": 0o440}},
                              {"name": "tls-tmp", "emptyDir": {}}])
    server["containers"].append({"name": "tls", "image": "nginx:1.30.5-alpine",
        "command": ["nginx", "-c", "/etc/headscale/tls.conf", "-g", "daemon off;"],
        "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
        "resources": {"requests": {"cpu": "10m", "memory": "32Mi"}, "limits": {"cpu": "500m", "memory": "128Mi"}},
        "volumeMounts": [{"name": "config", "mountPath": "/etc/headscale", "readOnly": True},
                         {"name": "tls", "mountPath": "/fixture-tls", "readOnly": True}, {"name": "tls-tmp", "mountPath": "/tmp"}],
        "readinessProbe": {"tcpSocket": {"port": 8443}, "periodSeconds": 1, "failureThreshold": 40}})
    objects.append(pod("target", "nginx:1.30.5-alpine", ["nginx", "-c", "/fixture/nginx.conf", "-g", "daemon off;"],
                       [{"name": "config", "mountPath": "/fixture", "readOnly": True}, {"name": "tmp", "mountPath": "/tmp"}],
                       [{"name": "config", "configMap": {"name": "target-config"}}, {"name": "tmp", "emptyDir": {}}]))
    for name in ["a", "r"]:
        objects.append(pod(name, "tailscale/tailscale:v1.102.5",
                           ["tailscaled", "--tun=userspace-networking", "--state=/var/lib/tailscale/g19/state",
                            "--socket=/var/run/tailscale/tailscaled.sock", "--outbound-http-proxy-listen=127.0.0.1:1056", "--port=41641"] + (["--verbose=1"] if name == "r" else []),
                           [{"name": "data", "mountPath": "/var/lib/tailscale"}, {"name": "run", "mountPath": "/var/run/tailscale"},
                            {"name": "tmp", "mountPath": "/tmp"}],
                           [{"name": "data", "emptyDir": {}}, {"name": "run", "emptyDir": {}}, {"name": "tmp", "emptyDir": {}}]))
    write_json(OUT / f"g19-{RUN}-manifest.json", {"namespace": namespace, "services": services, "objects": objects})
    create_objects(objects)
    ns(["wait", "--for=condition=Ready", "pod", "--all", "--timeout=90s"], timeout=100)
    pods = json.loads(ns(["get", "pods", "-o", "json"]).stdout)["items"]
    by_name = {item["metadata"]["name"]: item for item in pods}
    pod_ip = by_name["target"]["status"]["podIP"]
    result["routerPodIP"] = by_name["r"]["status"]["podIP"]
    targets = {"podip": pod_ip, "clusterip": service_ip}
    result["targets"] = targets
    result["podSecurity"] = [{"name": item["metadata"]["name"], "uid": item["metadata"]["uid"],
                              "podIP": item["status"]["podIP"], "hostNetwork": item["spec"].get("hostNetwork", False),
                              "hostPID": item["spec"].get("hostPID", False), "securityContext": item["spec"].get("securityContext"),
                              "containers": [{"image": container["image"], "securityContext": container.get("securityContext")}
                                             for container in item["spec"]["containers"]]} for item in pods]
    identity = 'printf "self_netns="; readlink /proc/self/ns/net; p=$(pidof tailscaled); printf "daemon_pid=%s\\ndaemon_netns=" "$p"; readlink "/proc/$p/ns/net"; id; grep -E "^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):" /proc/self/status; if [ -e /dev/net/tun ]; then echo tun_present=true; else echo tun_present=false; fi'
    result["routerSameContainerIdentity"] = execute("r", ["sh", "-c", identity]).stdout
    result["clientVersion"] = execute("a", ["tailscale", "version"]).stdout.strip()
    result["serverVersion"] = hs(["version"]).stdout.strip()
    assert result["clientVersion"].splitlines()[0].startswith("1.102.5")
    assert "0.29.4" in result["serverVersion"]
    keys = {}
    for name in ["a", "r"]:
        user = json.loads(hs(["users", "create", f"g19-{name}", "--output", "json"]).stdout)
        key = json.loads(hs(["preauthkeys", "create", "--user", str(user["id"]), "--expiration", "15m", "--output", "json"]).stdout)
        keys[name] = key["key"]
        SECRETS.append(key["key"])
    write_json(PRIVATE / "credentials.json", keys)
    router_routes = (f"{pod_ip}/32", f"{service_ip}/32") if SUBNET_MODE else ("0.0.0.0/0", "::/0")
    for name in ["r", "a"]:
        routes = ",".join(router_routes) if name == "r" else ""
        execute(name, ["sh", "-c", 'read -r key; exec tailscale up --reset --auth-key="$key" --login-server="$1" --hostname="$2" --advertise-routes="$3" --accept-routes=true --accept-dns=false --timeout=20s',
                       "sh", login, f"g19-{name}", routes], stdin=keys[name] + "\n", timeout=30)
    nodes = json.loads(hs(["nodes", "list", "--output", "json"]).stdout)
    router = next(node for node in nodes if node["given_name"] == "g19-r")
    result["routerNodeID"] = router["id"]
    router_tail_ip = next(address for address in router["ip_addresses"] if ":" not in address)
    result["routerTailnetIP"] = router_tail_ip
    result["clientTailnetIP"] = next(address for address in status("a")["Self"]["TailscaleIPs"] if ":" not in address)
    assert set(router["available_routes"]) == set(router_routes), "Router advertised routes outside the selected experiment mode"
    initial_direct = [request("a", address, "preflight", f"native-{kind}") for kind, address in targets.items()]
    result["initialADirect"] = initial_direct
    if any(map(successful, initial_direct)):
        # Isolate only this A from this T. WireGuard/control traffic to owned R/Headscale is unchanged.
        policy = {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": metadata("a-target-isolation"),
                  "spec": {"podSelector": {"matchLabels": {OWNER: RUN, "app.kubernetes.io/component": "a"}},
                           "policyTypes": ["Egress"], "egress": [{"to": [{"ipBlock": {"cidr": "0.0.0.0/0", "except": [f"{pod_ip}/32", f"{service_ip}/32"]}}]}]}}
        create_objects([policy])
        result["aIsolationPolicy"] = policy
    isolation_deadline = time.monotonic() + 8
    isolation_checks = []
    while True:
        isolated = [request("a", address, "isolated-preflight", f"native-{kind}") for kind, address in targets.items()]
        isolation_checks.append(isolated)
        if not any(map(successful, isolated)) or time.monotonic() >= isolation_deadline:
            break
        time.sleep(0.25)
    result["isolationReadinessChecks"] = isolation_checks
    result["isolatedADirect"] = isolated
    assert not any(map(successful, isolated)), "A native bypass remains after bounded CNI readiness checks; stop"
    comparisons = [("original-open", ["*:*"]), ("internet-only", ["autogroup:internet:*"]),
                   ("literal-private", [f"{pod_ip}/32:*", f"{service_ip}/32:*"])]
    # First check the original open rule before any route approval.
    set_policy(*comparisons[0])
    execute("r", ["tailscale", "serve", "--bg", "--yes", "--http=8081", f"text:G19_{RUN}_PEER"])
    result["routerServeConfig"] = json.loads(execute("r", ["tailscale", "serve", "status", "--json"]).stdout)
    result["routerServeHost"] = next(host for host in result["routerServeConfig"]["Web"] if host.endswith(":8081"))
    ping = execute("a", ["tailscale", "ping", "--until-direct=true", "--c=3", "--timeout=3s", router_tail_ip], check=False, timeout=15)
    result["peerReadinessPing"] = {"exit": ping.returncode, "stdout": scrub(ping.stdout), "stderr": scrub(ping.stderr)}
    peer = peer_request("peer-preflight")
    result["peerHTTPPreflight"] = peer
    result["peerStatusAfterPreflight"] = status("a")
    if not successful(peer):
        result["peerHopDiagnostic"] = diagnostic_capture(router_tail_ip)
        raise AssertionError("Tailnet HTTP peer positive failed; private sequence not run")
    result["routerProxyPreflight"] = [request("r", address, "router-proxy-preflight", kind, proxy=True) for kind, address in targets.items()]
    if SUBNET_MODE:
        return run_subnet_sequence(targets)
    baseline = phase("original-unapproved", targets)
    result["phases"].append(baseline)
    approve(True)
    execute("a", ["tailscale", "set", f"--exit-node={router_tail_ip}"])
    for name, destinations in comparisons:
        if name != "original-open":
            set_policy(name, destinations)
        comparison = phase(f"policy-{name}", targets)
        result["policyComparisons"].append(comparison)
    assert not any(successful(probe) for item in result["policyComparisons"] for probe in item["probes"]), "Default-only RFC1918 traffic unexpectedly succeeded"
    result["privateForwardingEstablished"] = False
    result["chosenPolicy"] = "original-open"
    set_policy(*comparisons[0])
    approve(False)
    execute("a", ["tailscale", "set", "--exit-node="])
    sequence_prefix = "observed"
    sequence = [phase(f"{sequence_prefix}-unapproved", targets)]
    approve(True)
    execute("a", ["tailscale", "set", f"--exit-node={router_tail_ip}"])
    sequence.append(phase(f"{sequence_prefix}-approved-selected", targets))
    approve(False)
    sequence.append(phase(f"{sequence_prefix}-revoked-still-selected", targets))
    approve(True)
    sequence.append(phase(f"{sequence_prefix}-restored-still-selected", targets))
    result["phases"].extend(sequence)
    negatives = [sequence[0], sequence[2]]
    positives = [sequence[1], sequence[3]]
    result["assertions"] = {
        "samePodAndClusterIPBackendPort": all(probe["port"] == 8081 for item in sequence for probe in item["probes"]),
        "routerHealthAlwaysPositive": all(successful(probe) for item in sequence for probe in item["health"]),
        "unapprovedAndRevokedFail": all(not successful(probe) and not probe["targetRecords"] for item in negatives for probe in item["probes"]),
        "approvedAndRestoredPassViaRouter": all(successful(probe) and probe["sourceIsRouter"] for item in positives for probe in item["probes"]),
        "exitSelectionRetainedAfterRevocation": bool(sequence[2]["before"]["A"]["ExitNodeStatus"]),
        "onlyDefaultRoutesAdvertised": all(set(item["before"]["RPrefs"]["AdvertiseRoutes"] or []) == {"0.0.0.0/0", "::/0"} for item in sequence),
    }
    observed_approvals = [any(str(node["id"]) == str(result["routerNodeID"]) and
                              {"0.0.0.0/0", "::/0"}.issubset(set(node.get("approved_routes") or []))
                              for node in item["before"]["nodes"]) for item in sequence]
    result["assertions"]["approvalReadbackSequence"] = observed_approvals == [False, True, False, True]
    prerequisites = [value for key, value in result["assertions"].items() if key != "approvedAndRestoredPassViaRouter"]
    assert all(prerequisites), "A four-stage prerequisite or negative-control assertion failed"
    assert all(not successful(probe) for item in sequence for probe in item["probes"]), "Default-only RFC1918 safety rejection failed"
    peer_after = peer_request("failed-path-control")
    result["peerHTTPAfterPrivateFailures"] = peer_after
    assert successful(peer_after), "Tailnet HTTP transport failed during the private sequence"
    result["hopDiagnostic"] = diagnostic_capture(service_ip)
    result["defaultPrivateRejectionPassed"] = True
    result["outcome"] = "Default-only exit rejects RFC1918 as expected; explicit subnet forwarding is a separate configuration"
    return 0


def main():
    code = 1
    try:
        code = run()
    except Exception as error:
        result["error"] = scrub(f"{type(error).__name__}: {error}")
        event("failure", error=result["error"])
    finally:
        if created:
            for name, container in [("a", "main"), ("r", "main"), ("headscale", "main"), ("headscale", "tls"), ("target", "main")]:
                log_name = name if container == "main" else f"{name}-{container}"
                try:
                    logs = ns(["logs", name, "-c", container, "--tail=150"], check=False, cleanup=True, timeout=10)
                    result.setdefault("finalLogs", {})[log_name] = {"exit": logs.returncode, "stdout": scrub(logs.stdout), "stderr": scrub(logs.stderr)}
                except Exception as error:
                    result.setdefault("finalLogErrors", {})[log_name] = scrub(error)
            try:
                owned = json.loads(kube(["get", "namespace", NS, "-o", "json"], cleanup=True, timeout=10).stdout)
                assert owned["metadata"]["labels"].get(OWNER) == RUN, "Ownership changed: refuse namespace deletion"
                assert owned["metadata"]["uid"] == result["namespaceUID"], "Namespace UID changed: refuse deletion"
                deletion = kube(["delete", "namespace", NS, "--wait=true", "--timeout=90s"], timeout=100, cleanup=True)
                readback = kube(["get", "namespace", NS, "--ignore-not-found", "-o", "name"], cleanup=True, timeout=10)
                result["cleanup"] = {"deleteExit": deletion.returncode, "readbackExit": readback.returncode,
                                     "namespaceAbsent": readback.stdout.strip() == "", "ownershipChecked": True}
                assert result["cleanup"]["namespaceAbsent"], "Namespace still exists"
            except Exception as error:
                result["cleanup"]["error"] = scrub(error)
                code = 1
        if PRIVATE.exists():
            shutil.rmtree(PRIVATE)
        result["privateCredentialDirectoryRemoved"] = not PRIVATE.exists()
        result["processExit"] = code
        result["elapsedSeconds"] = round(time.monotonic() - START, 3)
        write_json(RESULT, result)
        print(json.dumps({"result": str(RESULT), "events": str(EVENTS), "processExit": code,
                          "cleanup": result["cleanup"], "error": result.get("error")}, ensure_ascii=False), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())

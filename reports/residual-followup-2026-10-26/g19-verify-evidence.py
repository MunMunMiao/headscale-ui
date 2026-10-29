#!/usr/bin/env python3
"""Validate default-exit RFC1918 rejection and explicit-subnet forwarding as separate outcomes."""
import ast
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess

OUT = Path(__file__).resolve().parent
FINAL = OUT / "g19-932f6019ebf7-result.json"
d = json.loads(FINAL.read_text())
assert d["processExit"] == 2 and d["privateForwardingEstablished"] is False
assert d["assertions"]["approvedAndRestoredPassViaRouter"] is False
assert all(value for key, value in d["assertions"].items() if key != "approvedAndRestoredPassViaRouter")
source = ipaddress.ip_address(d["clientTailnetIP"])


def success(probe):
    return probe["exit"] == 0 and probe["httpStatus"] == 200 and probe["marker"]


def control_matches(mapping, address, source_address=None):
    # Netmap PacketFilter is only one guard; advertised localNets is checked independently by tailscaled.
    packet_source = source if source_address is None else ipaddress.ip_address(source_address)
    address = ipaddress.ip_address(address)
    for rule in mapping["PacketFilter"]:
        if 6 not in rule.get("IPProto", []):
            continue
        if not any(packet_source in ipaddress.ip_network(prefix) for prefix in rule.get("Srcs", [])):
            continue
        for destination in rule.get("Dsts", []):
            network = ipaddress.ip_network(destination["Net"])
            ports = destination["Ports"]
            if network.version == address.version and address in network and ports["First"] <= 8081 <= ports["Last"]:
                return True
    return False


assert all(success(d[key]) for key in ["peerHTTPPreflight", "peerHTTPAfterPrivateFailures"])
assert all(map(success, d["routerProxyPreflight"]))
assert not any(map(success, d["isolatedADirect"]))
sequence = [phase for phase in d["phases"] if phase["name"].startswith("observed-")]
assert len(sequence) == 4
assert [any("0.0.0.0/0" in (peer["AllowedIPs"] or []) for peer in phase["before"]["AMap"]["Peers"]) for phase in sequence] == [False, True, False, True]
assert [phase["before"]["APrefs"]["ExitNodeID"] for phase in sequence] == ["", str(d["routerNodeID"]), str(d["routerNodeID"]), str(d["routerNodeID"])]
assert all(success(probe) for phase in sequence for probe in phase["health"])
assert all(not success(probe) and not probe["targetRecords"] for phase in sequence for probe in phase["probes"])
assert all(control_matches(phase["before"]["RMap"], target) for phase in sequence for target in d["targets"].values())
opened, internet, literal = d["policyComparisons"]
assert all(control_matches(opened["before"]["RMap"], target) for target in d["targets"].values())
assert not any(control_matches(internet["before"]["RMap"], target) for target in d["targets"].values())
assert literal["before"]["RMap"]["Peers"]
assert not any(control_matches(literal["before"]["RMap"], target) for target in d["targets"].values())
hop = d["hopDiagnostic"]
assert control_matches(hop["before"]["RMap"], d["targets"]["clusterip"])
assert str(hop["before"]["A"]["ExitNodeStatus"]["ID"]) == str(d["routerNodeID"])
assert hop["captureLinktype"] == 147 and hop["captureExit"] == 143
assert any(packet["source"] == str(source) and packet["destination"] == d["targets"]["clusterip"] and packet["tcpFlags"] == 2
           for packet in hop["ownedFlowPacketHeaders"])
assert not any(hop["probe"]["token"] in entry["request"] for entry in hop["targetRecords"])
assert not any(socket["state"] in ["01", "02"] for socket in hop["routerSocketsOneSecondIntoProbe"])
router_health_records = [entry for entry in hop["targetRecords"] if "/health-" in entry["request"] or "/router-proxy-preflight/" in entry["request"]]
assert router_health_records and all(entry["source"] == d["routerPodIP"] for entry in router_health_records)
identity = d["routerSameContainerIdentity"]
netns = re.findall(r"(?:self|daemon)_netns=net:\[(\d+)\]", identity)
assert len(netns) == 2 and netns[0] == netns[1]
assert "NoNewPrivs:\t1" in identity and "tun_present=false" in identity
capabilities = re.findall(r"^Cap(?:Inh|Prm|Eff|Bnd|Amb):\s+([0-9a-f]+)$", identity, re.M)
assert len(capabilities) == 5 and all(int(value, 16) == 0 for value in capabilities)
assert len(d["podSecurity"]) == 4
for pod in d["podSecurity"]:
    assert not pod["hostNetwork"] and not pod["hostPID"]
    assert pod["securityContext"]["runAsNonRoot"]
    for container in pod["containers"]:
        security = container["securityContext"]
        assert security["allowPrivilegeEscalation"] is False and security["readOnlyRootFilesystem"] is True
        assert security["capabilities"]["drop"] == ["ALL"] and not security.get("privileged", False)

SUBNET = OUT / "g19-0feb8335414f-result.json"
s = json.loads(SUBNET.read_text())
assert s["mode"] == "explicit-subnet" and s["processExit"] == 0 and s["subnetForwardingPassed"]
assert s["defaultExitTested"] is False and s["policyComparisons"] == []
assert all(s["assertions"].values())
wanted = {f"{address}/32" for address in s["targets"].values()}
assert set(s["configuredRoutes"]) == wanted
assert [phase["name"] for phase in s["phases"]] == ["subnet-unapproved", "subnet-approved", "subnet-revoked", "subnet-restored"]
assert success(s["peerHTTPPreflight"]) and success(s["peerHTTPAfterSubnetSequence"])
for index, phase in enumerate(s["phases"]):
    approved = index in [1, 3]
    before = phase["before"]
    router = next(node for node in before["nodes"] if str(node["id"]) == str(s["routerNodeID"]))
    assert set(router["available_routes"] or []) == wanted
    assert set(router["approved_routes"] or []) == (wanted if approved else set())
    assert set(before["RPrefs"]["AdvertiseRoutes"] or []) == wanted
    assert before["APrefs"]["RouteAll"] and not before["APrefs"]["ExitNodeID"] and not before["APrefs"]["ExitNodeIP"]
    assert before["A"]["ExitNodeStatus"] is None
    received = {prefix for peer in before["AMap"]["Peers"] if str(peer["ID"]) == str(s["routerNodeID"])
                for prefix in (peer["AllowedIPs"] or [])}
    assert "0.0.0.0/0" not in received and "::/0" not in received
    route_state_matches = wanted <= received if approved else wanted.isdisjoint(received)
    assert route_state_matches
    assert all(control_matches(before["RMap"], address, s["clientTailnetIP"]) for address in s["targets"].values())
    assert len(phase["health"]) == 2 and all(map(success, phase["health"]))
    assert len(phase["direct"]) == 2 and all(probe["exit"] != 0 for probe in phase["direct"])
    for probe in phase["probes"]:
        actual = [entry for entry in phase["targetRecords"] if probe["token"] in entry["request"]]
        if approved:
            assert success(probe) and probe["sourceIsRouter"] and actual
            assert all(entry["source"] == s["routerPodIP"] and entry["status"] == 200 for entry in actual)
        else:
            assert probe["exit"] != 0 and not probe["marker"] and not actual and not probe["targetRecords"]
    for node_name, peer_id in [("A", s["routerNodeID"]), ("R", before["A"]["Self"]["ID"])]:
        prior = next(peer for peer in before[node_name]["peers"] if str(peer["ID"]) == str(peer_id))
        after = next(peer for peer in phase[f"after{node_name}"]["peers"] if str(peer["ID"]) == str(peer_id))
        deltas = {direction: after[counter] - prior[counter] for direction, counter in [("tx", "TxBytes"), ("rx", "RxBytes")]}
        assert deltas == phase["counterDeltas"][node_name]
        if approved:
            assert all(value > 0 for value in deltas.values())

subnet_identity = s["routerSameContainerIdentity"]
subnet_netns = re.findall(r"(?:self|daemon)_netns=net:\[(\d+)\]", subnet_identity)
assert len(subnet_netns) == 2 and subnet_netns[0] == subnet_netns[1]
assert "uid=1000" in subnet_identity and "NoNewPrivs:\t1" in subnet_identity and "tun_present=false" in subnet_identity
subnet_capabilities = re.findall(r"^Cap(?:Inh|Prm|Eff|Bnd|Amb):\s+([0-9a-f]+)$", subnet_identity, re.M)
assert len(subnet_capabilities) == 5 and all(int(value, 16) == 0 for value in subnet_capabilities)
def security_shape(record):
    return [(pod["name"], pod["hostNetwork"], pod["hostPID"], pod["securityContext"], pod["containers"])
            for pod in sorted(record["podSecurity"], key=lambda item: item["name"])]
assert security_shape(s) == security_shape(d)
assert s["clientVersion"] == d["clientVersion"] and s["serverVersion"] == d["serverVersion"]
policies = [entry["policy"] for entry in map(json.loads, (OUT / "g19-0feb8335414f-events.jsonl").read_text().splitlines()) if entry["kind"] == "policy"]
assert policies == [{"acls": [{"action": "accept", "src": ["*"], "dst": [f"{s['routerTailnetIP']}:*", "*:*"]}]}]

runs = []
for path in sorted(OUT.glob("g19-*-result.json")):
    record = json.loads(path.read_text())
    assert re.fullmatch(r"[a-f0-9]{12}", record["run"])
    assert record["namespace"] == f"hs-g19-1026-{record['run']}"
    assert record["cleanup"] == {"deleteExit": 0, "readbackExit": 0, "namespaceAbsent": True, "ownershipChecked": True}
    assert record["privateCredentialDirectoryRemoved"]
    assert not (OUT / f"g19-private-{record['run']}").exists()
    runs.append({"run": record["run"], "namespace": record["namespace"], "processExit": record["processExit"]})
assert not list(OUT.glob("g19-private-*"))
command = ["kubectl", "--context", "home", "--request-timeout=20s", "get", "namespace",
           *[run["namespace"] for run in runs], "--ignore-not-found", "-o", "json"]
readback = subprocess.run(command, capture_output=True, text=True, timeout=30)
assert readback.returncode == 0, "Namespace cleanup readback failed"
namespace_items = json.loads(readback.stdout)["items"] if readback.stdout.strip() else []
assert namespace_items == []

scanned = []
for path in sorted([*OUT.glob("g19-*"), OUT / "G19核验.md"]):
    if not path.is_file():
        continue
    text = path.read_text()
    assert not re.search(r"hskey-(?:auth|api|authreq)-[A-Za-z0-9_-]{15,}", text), f"Credential-shaped content in {path.name}"
    assert not re.search(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", text), f"Private key in {path.name}"
    if path.suffix == ".json":
        json.loads(text)
    elif path.suffix == ".jsonl":
        for line in text.splitlines():
            json.loads(line)
    elif path.suffix == ".py":
        ast.parse(text)
    scanned.append(path.name)
verification = {"evidenceChecksPassed": True, "defaultExitPrivateForwardingPassed": False,
                "defaultRFC1918RejectionExpected": True, "defaultHistoricalExit": d["processExit"],
                "defaultSourceResult": FINAL.name, "defaultCaptureBeforeRunIn": True,
                "defaultCapturedOwnedSYNHeaders": len(hop["ownedFlowPacketHeaders"]), "defaultCaptureExit": hop["captureExit"],
                "explicitSubnetForwardingPassed": True, "subnetExperimentExit": s["processExit"],
                "subnetSourceResult": SUBNET.name, "subnetSameRouterNetns": subnet_netns[0],
                "sameSecurityContextsAndVersions": True, "subnetACLUnchanged": True,
                "subnetStages": [{"name": phase["name"], "proxyExit": [probe["exit"] for probe in phase["probes"]],
                                  "httpStatus": [probe["httpStatus"] for probe in phase["probes"]],
                                  "sourceIsRouter": [probe["sourceIsRouter"] for probe in phase["probes"]],
                                  "counterDeltas": phase["counterDeltas"]} for phase in s["phases"]],
                "runs": runs, "namespaceReadback": {"command": command, "exit": readback.returncode, "stdoutBytes": len(readback.stdout.encode()), "items": []},
                "credentialAndParseScanFiles": scanned,
                "reproduceScriptSha256": hashlib.sha256((OUT / "g19-reproduce.py").read_bytes()).hexdigest()}
path = OUT / "g19-subnet-verification.json"
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
    json.dump(verification, stream, indent=2, ensure_ascii=False)
    stream.write("\n")
print(json.dumps(verification, ensure_ascii=False, indent=2))

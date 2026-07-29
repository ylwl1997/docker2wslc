import pytest

from docker2wslc import translate
from docker2wslc.compose import analyse


@pytest.mark.parametrize(
    "src,expected",
    [
        ("docker run -it ubuntu:24.04 bash", "wslc run -it ubuntu:24.04 bash"),
        ("docker ps", "wslc container list"),
        ("docker ps -a", "wslc container list --all"),
        ("docker ps -aq", "wslc container list -aq"),
        ("docker images", "wslc image list"),
        ("docker rmi -f abc123", "wslc image remove --force abc123"),
        ("docker rm -f web", "wslc container remove --force web"),
        ("docker build -t app:1 .", "wslc build -t app:1 ."),
        ("docker pull nginx:alpine", "wslc pull nginx:alpine"),
        ("docker exec -it web sh", "wslc exec -it web sh"),
        ("docker logs -f web", "wslc logs -f web"),
        ("sudo docker ps", "wslc container list"),
        ("podman run alpine", "wslc run alpine"),
        ("docker create --name x alpine", "wslc container create --name x alpine"),
        ("docker cp web:/etc/hosts ./hosts", "wslc container cp web:/etc/hosts ./hosts"),
        ("docker container prune", "wslc container prune"),
    ],
)
def test_basic_mapping(src, expected):
    assert translate(src).output == expected


# Subcommands absent in every form on wslc 2.9.4.0. `wslc image history` is NOT
# a valid target: the image noun has no history or search verb.
@pytest.mark.parametrize(
    "verb",
    ["history", "search", "restart", "pause", "unpause", "top", "wait", "port",
     "rename", "diff", "commit", "info"],
)
def test_no_equivalent_subcommands(verb):
    r = translate(f"docker {verb} nginx")
    assert r.output.startswith("#"), f"expected a comment, got: {r.output}"
    assert not r.output.startswith("wslc ")
    assert r.exit_code == 2


def test_system_prune_absent_but_per_noun_prunes_work():
    r = translate("docker system prune -a")
    assert r.output.startswith("#"), f"expected a comment, got: {r.output}"
    assert r.exit_code == 2
    for noun in ("container", "image", "volume", "network"):
        assert translate(f"docker {noun} prune").output == f"wslc {noun} prune"


def test_platform_dropped():
    r = translate("docker build --platform linux/amd64 -t app .")
    assert r.output == "wslc build -t app ."
    assert any("--platform" in n.text for n in r.notes)
    assert r.exit_code == 1


def test_platform_inline_dropped():
    assert translate("docker build --platform=linux/arm64 .").output == "wslc build ."


def test_gpus_kept_never_rewritten_to_device():
    # wslc 2.9.4.0 has --gpus natively and has NO --device. Rewriting to
    # --device turns a working command into one that fails with "Argument name
    # was not recognized". Verified on a Windows Server 2025 runner.
    r = translate("docker run --gpus all nvidia/cuda:12.4.0-base")
    assert r.output == "wslc run --gpus all nvidia/cuda:12.4.0-base"
    assert "--device" not in r.output


def test_device_dropped_because_wslc_has_no_such_flag():
    r = translate("docker run --device /dev/snd alpine")
    assert "--device" not in r.output
    assert r.exit_code == 1


@pytest.mark.parametrize(
    "src,expected",
    [
        ("docker run -m 512m alpine", "wslc run -m 512M alpine"),
        ("docker run --memory=1g alpine", "wslc run --memory=1G alpine"),
        ("docker run --shm-size 64m alpine", "wslc run --shm-size 64M alpine"),
        ("docker run -m 512mb alpine", "wslc run -m 512MB alpine"),
    ],
)
def test_lowercase_size_units_are_rewritten(src, expected):
    # wslc rejects `512m` with `Invalid memory argument value`; Docker accepts
    # both cases, so a copied command silently breaks. Fix it, don't just warn.
    r = translate(src)
    assert r.output == expected
    assert r.exit_code == 1


def test_already_uppercase_size_is_untouched_and_clean():
    r = translate("docker run -m 2G alpine")
    assert r.output == "wslc run -m 2G alpine"
    assert r.exit_code == 0


def test_unparseable_size_is_still_an_error():
    r = translate("docker run -m bogus alpine")
    assert r.exit_code == 2


# Flags Docker has that `wslc run` does not implement at all: passing them
# through would produce "Argument name was not recognized" at runtime.
@pytest.mark.parametrize(
    "flag,src",
    [
        ("--cap-add", "docker run --cap-add NET_ADMIN alpine"),
        ("--cap-drop", "docker run --cap-drop ALL alpine"),
        ("--privileged", "docker run --privileged alpine"),
        ("--security-opt", "docker run --security-opt seccomp=unconfined alpine"),
        ("--expose", "docker run --expose 8080 nginx"),
        ("--device", "docker run --device /dev/snd alpine"),
    ],
)
def test_nonexistent_run_flags_are_dropped(flag, src):
    r = translate(src)
    assert flag not in r.output, f"{flag} must not survive into the output"
    assert r.exit_code == 1


# Flags that DO exist on wslc run and must survive untouched.
@pytest.mark.parametrize(
    "src",
    [
        "docker run --gpus all nvidia/cuda:12.4-base",
        "docker run --health-cmd 'pg_isready -U postgres' postgres:16",
        "docker run --no-healthcheck redis",
        "docker run -P nginx",
        "docker run --ulimit nofile=1024:2048 alpine",
        "docker run --stop-signal SIGINT alpine",
        "docker run --dns 1.1.1.1 alpine",
        "docker run --network none alpine",
        "docker run --tmpfs /tmp alpine",
    ],
)
def test_supported_flags_survive(src):
    r = translate(src)
    flag = [t for t in src.split() if t.startswith("-")][0]
    assert flag in r.output, f"{flag} exists on wslc and must be kept"
    assert r.exit_code in (0, 1)


def test_restart_dropped_is_warning():
    r = translate("docker run --restart always -d redis")
    assert "--restart" not in r.output
    assert r.exit_code == 1


def test_network_host_is_error_not_silently_dropped():
    # wslc refuses host networking loudly (exit 1, "host mode networking is not
    # supported") rather than ignoring it, so the result is unmigratable.
    r = translate("docker run --network host alpine")
    assert r.exit_code == 2
    assert any(
        n.severity == "error" and "host mode networking is not supported" in n.text
        for n in r.notes
    )


def test_network_custom_kept():
    r = translate("docker run --network mynet alpine")
    assert "--network mynet" in r.output


def test_compose_is_unmigratable():
    r = translate("docker compose up -d")
    assert r.compose_hit is True
    assert r.exit_code == 2


def test_unsupported_verb():
    r = translate("docker swarm init")
    assert r.unsupported_hit is True
    assert r.exit_code == 2


def test_buildx_unsupported():
    assert translate("docker buildx build .").exit_code == 2


def test_windows_path_note():
    r = translate("docker run -v C:/work:/app -it ubuntu bash")
    assert "-v C:/work:/app" in r.output
    assert any("VirtioFS" in n.text for n in r.notes)


def test_quoted_args_preserved():
    r = translate('docker run alpine sh -c "echo hello world"')
    assert '"echo hello world"' in r.output


def test_comments_and_blanks_preserved():
    r = translate("# setup\ndocker ps\n\ndocker images")
    assert r.output.splitlines()[0] == "# setup"
    assert "wslc container list" in r.output
    assert "wslc image list" in r.output


def test_non_docker_line_untouched():
    r = translate("ls -la")
    assert r.output.startswith("# not a docker command")


def test_clean_command_exit_zero():
    assert translate("docker run alpine").exit_code == 0


def test_unknown_verb_is_degraded():
    r = translate("docker frobnicate x")
    assert r.exit_code == 1
    assert "wslc frobnicate x" == r.output


def test_notes_deduplicated():
    r = translate("docker build --platform linux/amd64 .\ndocker run --platform linux/amd64 alpine")
    platform_notes = [n for n in r.notes if "--platform" in n.text]
    assert len(platform_notes) == 1


COMPOSE = """
services:
  web:
    image: nginx:alpine
    ports: ["8080:80"]
    environment:
      - NGINX_HOST=localhost
    depends_on: [db]
    restart: always
  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      retries: 5
    cap_add: [NET_ADMIN]
    mem_limit: 512m
volumes:
  pgdata:
"""


def test_compose_analysis():
    yaml = pytest.importorskip("yaml")  # noqa: F841
    rep = analyse(COMPOSE)
    assert rep.parse_error is None
    names = [s.name for s in rep.services]
    assert names == ["web", "db"]

    web = rep.services[0]
    assert "wslc run -d --name web" in web.command
    assert "-p 8080:80" in web.command
    assert "-e NGINX_HOST=localhost" in web.command
    assert "nginx:alpine" in web.command

    missing = dict(web.missing)
    assert "depends_on" in missing
    assert "restart" in missing

    db = rep.services[1]
    # healthcheck IS supported: wslc run has --health-cmd and friends, so the
    # block is translated into flags rather than reported as missing.
    assert "healthcheck" not in dict(db.missing)
    assert "healthcheck" in db.ok
    assert "--health-cmd 'pg_isready -U postgres'" in db.command
    assert "--health-interval 10s" in db.command
    assert "--health-retries 5" in db.command
    # mem_limit: 512m must be uppercased or wslc rejects it.
    assert "-m 512M" in db.command
    assert "cap_add" in dict(db.missing)
    # Flags wslc does not have must never appear in generated compose commands.
    for absent in ("--cap-add", "--device", "--privileged", "--security-opt", "--expose"):
        assert absent not in db.command
    assert "wslc volume create pgdata" in rep.prelude
    assert rep.exit_code == 2


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("30s", "30"),
        ("1m30s", "90"),   # compound: a single-unit regex would pass this through
        ("2h5m", "7500"),
        ("90", "90"),
        ("bogus", "bogus"),
    ],
)
def test_stop_grace_period_to_seconds(raw, expected):
    from docker2wslc.compose import _stop_seconds

    assert _stop_seconds(raw) == expected


def test_cli_passthrough_of_docker_flags():
    """argparse must not claim --gpus/--platform/-p as its own options."""
    from docker2wslc.cli import main

    assert main(["convert", "-q", "docker", "run", "--gpus", "all", "nginx"]) == 0
    assert main(["convert", "-q", "docker", "build", "--platform", "linux/amd64", "."]) == 1
    assert main(["convert", "-q", "docker", "compose", "up", "-d"]) == 2
    assert main(["convert", "-q", "sudo", "docker", "ps", "-a"]) == 0


def test_compose_bad_yaml():
    pytest.importorskip("yaml")
    rep = analyse("services: [oops")
    assert rep.parse_error is not None
    assert rep.exit_code == 2

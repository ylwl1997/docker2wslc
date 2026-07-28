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
        ("docker history nginx", "wslc image history nginx"),
        ("docker create --name x alpine", "wslc container create --name x alpine"),
    ],
)
def test_basic_mapping(src, expected):
    assert translate(src).output == expected


def test_platform_dropped():
    r = translate("docker build --platform linux/amd64 -t app .")
    assert r.output == "wslc build -t app ."
    assert any("--platform" in n.text for n in r.notes)
    assert r.exit_code == 1


def test_platform_inline_dropped():
    assert translate("docker build --platform=linux/arm64 .").output == "wslc build ."


def test_gpus_rewritten():
    r = translate("docker run --gpus all nvidia/cuda:12.4.0-base")
    assert r.output == "wslc run --device nvidia.com/gpu=all nvidia/cuda:12.4.0-base"


def test_restart_dropped_is_warning():
    r = translate("docker run --restart always -d redis")
    assert "--restart" not in r.output
    assert r.exit_code == 1


def test_network_host_dropped():
    r = translate("docker run --network host alpine")
    assert r.output == "wslc run alpine"


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
      test: ["CMD", "pg_isready"]
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
    assert "healthcheck" in dict(db.missing)
    assert "wslc volume create pgdata" in rep.prelude
    assert rep.exit_code == 2


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

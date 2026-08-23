from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Aegis-Drive Telemetry Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SimulationRequest(BaseModel):
    hazard_type: str
    action: str
    seed_image: str = ""


class TelemetryData(BaseModel):
    trajectory: str
    ttc: float
    lat_g: float
    lon_g: float
    liability: int
    asil: str
    asil_color: str
    prompt: str
    audio: str


class SimulationResponse(BaseModel):
    seed_injected: bool
    telemetry: TelemetryData


TRAJECTORY_MAP = {
    "HARD_BRAKE": lambda h: TelemetryData(
        trajectory="Trajectory A: Safe Brake",
        ttc=2.1,
        lat_g=0.1,
        lon_g=-1.2,
        liability=0,
        asil="ASIL-A (SAFE)",
        asil_color="green",
        prompt=(
            f"Cockpit view, ego-vehicle executing maximum threshold braking. "
            f"{h} safely avoided. ABS engages, nose dips under heavy deceleration, "
            f"vehicle comes to a controlled stop with safe clearance."
        ),
        audio="heavy_abs_brake_squeal",
    ),
    "EMERGENCY_SWERVE": lambda h: TelemetryData(
        trajectory="Trajectory B: Swerve",
        ttc=1.4,
        lat_g=1.6,
        lon_g=-0.4,
        liability=15000,
        asil="ASIL-D (WARNING)",
        asil_color="yellow",
        prompt=(
            f"Cockpit view, violent evasive swerve to the left to avoid {h}. "
            f"Suspension flexes near rollover threshold. Lateral motion blur, "
            f"tire smoke, guardrail scraping sparks."
        ),
        audio="violent_tire_skid_and_warning_chime",
    ),
    "MAINTAIN_COURSE": lambda h: TelemetryData(
        trajectory="Trajectory C: Impact",
        ttc=0.0,
        lat_g=0.0,
        lon_g=-45.0,
        liability=85000,
        asil="ASIL-D (CRITICAL FAILURE)",
        asil_color="red",
        prompt=(
            f"Cockpit view, catastrophic frontal collision with {h}. "
            f"Windshield shatters, hood crumples, airbags deploy, camera "
            f"jolts violently and loses focus."
        ),
        audio="deafening_crash_and_glass_shatter",
    ),
}


@app.post("/simulate", response_model=SimulationResponse)
async def simulate(request: SimulationRequest):
    builder = TRAJECTORY_MAP.get(request.action, TRAJECTORY_MAP["MAINTAIN_COURSE"])
    telemetry = builder(request.hazard_type)
    return SimulationResponse(seed_injected=True, telemetry=telemetry)


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "Aegis-Drive Telemetry v2.0"}

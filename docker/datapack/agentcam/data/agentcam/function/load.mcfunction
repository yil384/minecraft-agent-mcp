# the live camera's counters (docker/datapack/agentcam; the camera service only sets tags through the console:
# agentcam on the camera player, agentcam_third for the third-person view, agentcam_target on the bot it films)
scoreboard objectives add agentcam_enc dummy
scoreboard objectives add agentcam_open dummy
scoreboard objectives add agentcam_t dummy
# the smoothed yaw of the camera, in tenths of a degree, and the constants its arithmetic needs
scoreboard objectives add agentcam_y dummy
scoreboard players set #3600 agentcam_y 3600
scoreboard players set #15 agentcam_y 30
scoreboard players set #100 agentcam_y 100
# the cool-down of a regroup (a dimension change, a respawn far away)
scoreboard objectives add agentcam_cd dummy
# the ticks since the last regroup, for the rides asked for again after it
scoreboard objectives add agentcam_rr dummy
# the orbit around a shut-in bot turns back with this
scoreboard players set #m1 agentcam_y -1
# the evidence of the camera's spots (agentcam:note): its number, and the last the camera service had printed to the
# server log (docker/datapack; src/camera.js keepFollowingCommands asks for it when they differ)
execute unless score cam_seq agentcam_y matches 0.. run scoreboard players set cam_seq agentcam_y 0
execute unless score cam_logged agentcam_y matches 0.. run scoreboard players set cam_logged agentcam_y 0

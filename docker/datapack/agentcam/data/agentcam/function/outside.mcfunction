# the bot is enclosed: film it from outside, never from inside a block, never against a ceiling. #on says how:
# 0 choose a spot (agentcam:choose), 1 the orbit (5 blocks out and 3.5 up, turning slowly), 2 a fixed spot (the
# nearest good one within 8 blocks, or high above), 3 none outside (sealed in under rock): first person. Every spot
# the eye stands at passes agentcam:good, each tick: open air with room around it, and a clear line to the shelter.
# room inside (a hut) and the bot seen from behind it there: that view (agentcam:inside); else from outside
function agentcam:inside
execute if score #in agentcam_y matches 14.. run return 0
execute if score #on agentcam_y matches 1 run function agentcam:orbit
execute if score #on agentcam_y matches 2 run function agentcam:hold
execute if score #on agentcam_y matches 3 run function agentcam:deep
execute if score #on agentcam_y matches 0 run function agentcam:choose

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentDeskRegistry} from "../src/AgentDeskRegistry.sol";
import {TUSD} from "../src/TUSD.sol";

contract AgentDeskRegistryTest is Test {
    TUSD internal tusd;
    AgentDeskRegistry internal registry;

    address internal platform;
    address internal creator;
    address internal stranger;
    address internal builder;
    address internal payTo;

    uint256 internal constant PRICE = 10_000; // 0.01 tUSD
    uint256 internal constant FLOOR = PRICE * 10; // 0.10 tUSD
    uint256 internal constant AGENT_ID = 2173;
    string internal constant AGENT_TYPE = "data";
    string internal constant ENDPOINT = "https://agents.example/binance-ticker";

    event Listed(
        uint256 indexed listingId,
        address indexed creator,
        uint256 indexed agentId,
        string agentType,
        uint256 price,
        string endpoint,
        address payTo,
        uint256 stake
    );
    event Staked(uint256 indexed listingId, address indexed from, uint256 amount, uint256 stake);
    event PriceSet(uint256 indexed listingId, uint256 price);
    event Paused(uint256 indexed listingId, bool pausedByCreator, bool pausedByStake);
    event Slashed(uint256 indexed listingId, bytes32 indexed callRef, uint256 amount);
    event ReputationSet(uint256 indexed listingId, uint16 bps);

    function setUp() public {
        platform = makeAddr("platform wallet");
        creator = makeAddr("creator wallet");
        stranger = makeAddr("stranger");
        builder = makeAddr("builder system wallet");
        payTo = makeAddr("agent payout wallet");

        tusd = new TUSD();
        registry = new AgentDeskRegistry(IERC20(address(tusd)), platform);
        _fund(creator);
        _fund(stranger);
    }

    // -------------------------------------------------------------------- list

    function test_ListLocksStakeAndRecordsEveryChainOwnedColumn() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit Listed(1, creator, AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, payTo, FLOOR);

        vm.prank(creator);
        uint256 listingId = registry.list(AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, payTo, FLOOR);

        assertEq(listingId, 1);
        assertEq(registry.listingCount(), 1);
        assertEq(tusd.balanceOf(address(registry)), FLOOR, "stake must sit in the registry");

        AgentDeskRegistry.Listing memory listing = registry.getListing(listingId);
        assertEq(listing.creator, creator);
        assertEq(listing.payTo, payTo);
        assertEq(listing.agentId, AGENT_ID);
        assertEq(listing.agentType, AGENT_TYPE);
        assertEq(listing.endpoint, ENDPOINT);
        assertEq(listing.price, PRICE);
        assertEq(listing.stake, FLOOR);
        assertEq(listing.reputationBps, 0);
        assertFalse(listing.pausedByCreator);
        assertFalse(listing.pausedByStake);
    }

    /// @dev AD-2: every amount is *pulled*, so an exact approval is spent to the cent and
    ///      an approval one short refuses the listing before any state is written.
    function test_ListPullsStakeWithTransferFromAgainstAFiniteApproval() public {
        address exact = makeAddr("creator with an exact approval");
        tusd.mint(exact, tusd.MINT_CAP());
        vm.prank(exact);
        tusd.approve(address(registry), FLOOR);

        uint256 before = tusd.balanceOf(exact);
        vm.prank(exact);
        registry.list(AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, payTo, FLOOR);

        assertEq(tusd.balanceOf(exact), before - FLOOR);
        assertEq(tusd.allowance(exact, address(registry)), 0, "the whole approval was pulled");
        assertEq(tusd.balanceOf(address(registry)), FLOOR);
    }

    function test_ListRevertsWhenTheApprovalIsOneShort() public {
        address tight = makeAddr("creator who under-approved");
        tusd.mint(tight, tusd.MINT_CAP());
        vm.prank(tight);
        tusd.approve(address(registry), FLOOR - 1);

        vm.prank(tight);
        vm.expectRevert(); // ERC20InsufficientAllowance, raised inside tUSD's transferFrom
        registry.list(AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, payTo, FLOOR);
        assertEq(registry.listingCount(), 0);
    }

    function test_ListRevertsWhenStakeBelowTenTimesPrice() public {
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(AgentDeskRegistry.StakeBelowMinimum.selector, FLOOR - 1, FLOOR)
        );
        registry.list(AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, payTo, FLOOR - 1);

        assertEq(registry.listingCount(), 0, "a refused listing must not consume an id");
        assertEq(tusd.balanceOf(address(registry)), 0, "a refused listing must lock no stake");
    }

    function test_ListRevertsOnZeroPriceEmptyEndpointAndZeroPayTo() public {
        vm.startPrank(creator);
        vm.expectRevert(AgentDeskRegistry.ZeroPrice.selector);
        registry.list(AGENT_ID, AGENT_TYPE, 0, ENDPOINT, payTo, FLOOR);

        vm.expectRevert(AgentDeskRegistry.ZeroAddress.selector);
        registry.list(AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, address(0), FLOOR);

        vm.expectRevert(AgentDeskRegistry.EmptyEndpoint.selector);
        registry.list(AGENT_ID, AGENT_TYPE, PRICE, "", payTo, FLOOR);
        vm.stopPrank();
    }

    function test_ListRevertsWhenCreatorCannotCoverTheStake() public {
        address poor = makeAddr("creator with no tUSD");
        vm.prank(poor);
        tusd.approve(address(registry), type(uint256).max);

        vm.prank(poor);
        vm.expectRevert(); // ERC20InsufficientBalance, raised by the tUSD transferFrom
        registry.list(AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, payTo, FLOOR);
    }

    // ---------------------------------------------------------------- addStake

    function test_AddStakePullsAndAccumulates() public {
        uint256 listingId = _list();

        vm.expectEmit(true, true, true, true, address(registry));
        emit Staked(listingId, creator, 500, FLOOR + 500);

        vm.prank(creator);
        registry.addStake(listingId, 500);

        assertEq(registry.getListing(listingId).stake, FLOOR + 500);
        assertEq(tusd.balanceOf(address(registry)), FLOOR + 500);
    }

    function test_AddStakeClearsTheStakePauseOnceStakeReachesTenTimesPrice() public {
        uint256 listingId = _list();
        _slashToZero(listingId);
        assertTrue(registry.getListing(listingId).pausedByStake);

        // Below the floor: still paused.
        vm.prank(creator);
        registry.addStake(listingId, FLOOR - 1);
        assertTrue(registry.getListing(listingId).pausedByStake, "still short of ten times price");

        // Reaching the floor clears it, and says so in an event.
        vm.expectEmit(true, true, true, true, address(registry));
        emit Paused(listingId, false, false);
        vm.prank(creator);
        registry.addStake(listingId, 1);

        AgentDeskRegistry.Listing memory listing = registry.getListing(listingId);
        assertFalse(listing.pausedByStake);
        assertEq(listing.stake, FLOOR);
    }

    function test_AddStakeDoesNotClearTheCreatorPause() public {
        uint256 listingId = _list();
        vm.prank(creator);
        registry.setPaused(listingId, true);
        _slashToZero(listingId);

        vm.prank(creator);
        registry.addStake(listingId, FLOOR);

        AgentDeskRegistry.Listing memory listing = registry.getListing(listingId);
        assertFalse(listing.pausedByStake);
        assertTrue(listing.pausedByCreator, "the two pauses are independent");
    }

    function test_AddStakeRevertsOnZeroAmountAndUnknownListing() public {
        uint256 listingId = _list();
        vm.prank(creator);
        vm.expectRevert(AgentDeskRegistry.ZeroAmount.selector);
        registry.addStake(listingId, 0);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.UnknownListing.selector, 99));
        registry.addStake(99, 1);
    }

    // ---------------------------------------------------------------- setPrice

    function test_SetPriceRevertsWhenStakeWouldFallBelowTenTimesNewPrice() public {
        uint256 listingId = _list(); // stake == FLOOR == 10 x PRICE
        uint256 tooHigh = PRICE + 1;

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(AgentDeskRegistry.StakeBelowMinimum.selector, FLOOR, tooHigh * 10)
        );
        registry.setPrice(listingId, tooHigh);

        assertEq(registry.getListing(listingId).price, PRICE, "a refused change must not land");
    }

    function test_SetPriceSucceedsWhenTheStakeStillCovers() public {
        uint256 listingId = _list();
        vm.prank(creator);
        registry.addStake(listingId, FLOOR); // stake == 2 x FLOOR

        vm.expectEmit(true, true, true, true, address(registry));
        emit PriceSet(listingId, PRICE * 2);
        vm.prank(creator);
        registry.setPrice(listingId, PRICE * 2);

        assertEq(registry.getListing(listingId).price, PRICE * 2);
        assertEq(registry.requiredStake(listingId), PRICE * 20);
    }

    function test_SetPriceDownIsAlwaysAllowed() public {
        uint256 listingId = _list();
        vm.prank(creator);
        registry.setPrice(listingId, PRICE / 2);
        assertEq(registry.getListing(listingId).price, PRICE / 2);
    }

    function test_SetPriceRevertsForNonCreatorAndOnZero() public {
        uint256 listingId = _list();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.NotCreator.selector, listingId, stranger));
        registry.setPrice(listingId, 1);

        vm.prank(creator);
        vm.expectRevert(AgentDeskRegistry.ZeroPrice.selector);
        registry.setPrice(listingId, 0);
    }

    // --------------------------------------------------------------- setPaused

    function test_SetPausedIsCreatorOnly() public {
        uint256 listingId = _list();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.NotCreator.selector, listingId, stranger));
        registry.setPaused(listingId, true);

        // Not even the platform may flip the Creator's switch.
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.NotCreator.selector, listingId, platform));
        registry.setPaused(listingId, true);

        vm.expectEmit(true, true, true, true, address(registry));
        emit Paused(listingId, true, false);
        vm.prank(creator);
        registry.setPaused(listingId, true);
        assertTrue(registry.getListing(listingId).pausedByCreator);

        vm.prank(creator);
        registry.setPaused(listingId, false);
        assertFalse(registry.getListing(listingId).pausedByCreator);
    }

    // ------------------------------------------------------------------- slash

    function test_SlashPaysTheBuilderAndLeavesTheListingRunning() public {
        uint256 listingId = _list();
        bytes32 callRef = keccak256("call_01JABCDEF");

        vm.expectEmit(true, true, true, true, address(registry));
        emit Slashed(listingId, callRef, PRICE);

        vm.prank(platform);
        uint256 slashed = registry.slash(listingId, callRef, PRICE, builder);

        assertEq(slashed, PRICE);
        assertEq(tusd.balanceOf(builder), PRICE);
        assertEq(tusd.balanceOf(address(registry)), FLOOR - PRICE);

        AgentDeskRegistry.Listing memory listing = registry.getListing(listingId);
        assertEq(listing.stake, FLOOR - PRICE);
        assertFalse(listing.pausedByStake, "a partial slash does not pause");
    }

    function test_SlashClampsToRemainingStakeEmitsClampedAmountAndPausesAtZero() public {
        uint256 listingId = _list();
        bytes32 callRef = keccak256("call_over");

        vm.expectEmit(true, true, true, true, address(registry));
        emit Paused(listingId, false, true);
        vm.expectEmit(true, true, true, true, address(registry));
        emit Slashed(listingId, callRef, FLOOR); // the clamped amount, not the asked amount

        vm.prank(platform);
        uint256 slashed = registry.slash(listingId, callRef, FLOOR * 3, builder);

        assertEq(slashed, FLOOR, "clamped to the remaining stake");
        assertEq(tusd.balanceOf(builder), FLOOR);
        assertEq(tusd.balanceOf(address(registry)), 0);

        AgentDeskRegistry.Listing memory listing = registry.getListing(listingId);
        assertEq(listing.stake, 0);
        assertTrue(listing.pausedByStake, "FR-8: zero stake pauses the listing");
    }

    function test_SlashOnAnEmptyStakeMovesNothingAndStillRecordsTheCall() public {
        uint256 listingId = _list();
        _slashToZero(listingId);

        vm.expectEmit(true, true, true, true, address(registry));
        emit Slashed(listingId, keccak256("call_second"), 0);
        vm.prank(platform);
        uint256 slashed = registry.slash(listingId, keccak256("call_second"), PRICE, builder);

        assertEq(slashed, 0, "a drained listing is not a wedged settlement tick");
        assertEq(tusd.balanceOf(builder), FLOOR);
    }

    function test_SlashIsPlatformOnly() public {
        uint256 listingId = _list();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.NotPlatform.selector, stranger));
        registry.slash(listingId, bytes32(0), PRICE, builder);

        // Not even the Creator may slash their own listing.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.NotPlatform.selector, creator));
        registry.slash(listingId, bytes32(0), PRICE, builder);
    }

    function test_SlashRevertsOnZeroRecipient() public {
        uint256 listingId = _list();
        vm.prank(platform);
        vm.expectRevert(AgentDeskRegistry.ZeroAddress.selector);
        registry.slash(listingId, bytes32(0), PRICE, address(0));
    }

    function testFuzz_SlashNeverPaysMoreThanTheStake(uint256 amount) public {
        uint256 listingId = _list();
        vm.prank(platform);
        uint256 slashed = registry.slash(listingId, bytes32(uint256(1)), amount, builder);

        assertLe(slashed, FLOOR);
        assertEq(slashed, amount > FLOOR ? FLOOR : amount);
        assertEq(tusd.balanceOf(builder), slashed);
        assertEq(registry.getListing(listingId).stake, FLOOR - slashed);
    }

    // ----------------------------------------------------------- setReputation

    function test_SetReputationIsPlatformOnly() public {
        uint256 listingId = _list();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.NotPlatform.selector, stranger));
        registry.setReputation(listingId, 5_000);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.NotPlatform.selector, creator));
        registry.setReputation(listingId, 5_000);

        vm.expectEmit(true, true, true, true, address(registry));
        emit ReputationSet(listingId, 6_667);
        vm.prank(platform);
        registry.setReputation(listingId, 6_667);
        assertEq(registry.getListing(listingId).reputationBps, 6_667);
    }

    function test_SetReputationRevertsAboveOneHundredPercent() public {
        uint256 listingId = _list();
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.ReputationOutOfRange.selector, 10_001));
        registry.setReputation(listingId, 10_001);

        vm.prank(platform);
        registry.setReputation(listingId, 10_000);
        assertEq(registry.getListing(listingId).reputationBps, registry.MAX_REPUTATION_BPS());
    }

    // -------------------------------------------------------------------- read

    function test_GetListingRevertsForAnUnknownId() public {
        vm.expectRevert(abi.encodeWithSelector(AgentDeskRegistry.UnknownListing.selector, 1));
        registry.getListing(1);
    }

    function test_ListingIdsAreSequentialAndIndependent() public {
        uint256 first = _list();
        vm.prank(stranger);
        uint256 second = registry.list(7, "research", PRICE, "https://b.example", stranger, FLOOR);

        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(registry.getListing(second).creator, stranger);
        assertEq(registry.getListing(second).agentType, "research");

        vm.prank(platform);
        registry.slash(second, bytes32(uint256(2)), FLOOR, builder);
        assertEq(registry.getListing(first).stake, FLOOR, "one listing's slash must not touch another");
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(AgentDeskRegistry.ZeroAddress.selector);
        new AgentDeskRegistry(IERC20(address(0)), platform);

        vm.expectRevert(AgentDeskRegistry.ZeroAddress.selector);
        new AgentDeskRegistry(IERC20(address(tusd)), address(0));
    }

    function test_ImmutablesAreWiredForTheDeployedShape() public view {
        assertEq(address(registry.token()), address(tusd));
        assertEq(registry.platform(), platform);
        assertEq(registry.STAKE_MULTIPLE(), 10);
    }

    // ---------------------------------------------------------------- internal

    function _fund(address who) internal {
        tusd.mint(who, tusd.MINT_CAP());
        vm.prank(who);
        tusd.approve(address(registry), type(uint256).max);
    }

    function _list() internal returns (uint256 listingId) {
        vm.prank(creator);
        listingId = registry.list(AGENT_ID, AGENT_TYPE, PRICE, ENDPOINT, payTo, FLOOR);
    }

    function _slashToZero(uint256 listingId) internal {
        vm.prank(platform);
        registry.slash(listingId, keccak256("call_drain"), type(uint256).max, builder);
    }
}

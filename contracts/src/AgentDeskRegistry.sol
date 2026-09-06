// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title AgentDeskRegistry
 * @notice The on-chain system of record for Listings (AD-2): price, stake, reputation,
 *         the two pause flags, payout wallet, endpoint, and the ERC-8004 agent id.
 *
 * @dev Everything the platform shows about a Listing is read back from {getListing} by
 *      `refreshListingFromChain`, which is the only writer of the database cache. Nothing
 *      here trusts the platform for a number it can hold itself.
 *
 * @dev Two independent pause flags, because they have different owners and different
 *      clearing rules. `pausedByCreator` is the Creator's switch. `pausedByStake` is set by
 *      the contract when {slash} empties the stake (FR-8) and cleared only by {addStake}
 *      once the stake is back at or above the floor. A Listing is unavailable when either
 *      is set; the platform decides what "available" means, this contract just reports both.
 *
 * @dev Stake floor is {STAKE_MULTIPLE} times the price, checked on {list} and {setPrice}
 *      (FR-7, FR-9). It is not re-checked on {slash}: a slash must always be payable, so it
 *      takes what is there and pauses instead of reverting.
 *
 * @dev Stake withdrawal is deliberately absent (FR-7). Stake leaves a Listing only through
 *      {slash}.
 */
contract AgentDeskRegistry {
    using SafeERC20 for IERC20;

    /// @notice A Listing's stake must be at least this many times its price per call.
    uint256 public constant STAKE_MULTIPLE = 10;

    /// @notice Reputation is basis points, so this is a perfect score.
    uint16 public constant MAX_REPUTATION_BPS = 10_000;

    struct Listing {
        address creator;
        address payTo;
        uint256 agentId;
        string agentType;
        string endpoint;
        uint256 price;
        uint256 stake;
        uint16 reputationBps;
        bool pausedByCreator;
        bool pausedByStake;
    }

    /// @notice The tUSD token every stake and slash moves.
    IERC20 public immutable token;

    /// @notice The Platform Wallet: the only account that may {slash} or {setReputation}.
    address public immutable platform;

    uint256 private _lastListingId;
    mapping(uint256 listingId => Listing) private _listings;

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

    /// @dev No Listing has been created under `listingId`.
    error UnknownListing(uint256 listingId);
    /// @dev The caller is not the Listing's creator.
    error NotCreator(uint256 listingId, address caller);
    /// @dev The caller is not the Platform Wallet.
    error NotPlatform(address caller);
    /// @dev `stake` is below `required` = {STAKE_MULTIPLE} times the price.
    error StakeBelowMinimum(uint256 stake, uint256 required);
    /// @dev A price of zero would make the stake floor meaningless.
    error ZeroPrice();
    /// @dev A zero amount would emit an event that records nothing.
    error ZeroAmount();
    /// @dev A zero address was given where a payable account is required.
    error ZeroAddress();
    /// @dev An empty endpoint cannot be called.
    error EmptyEndpoint();
    /// @dev `bps` is above {MAX_REPUTATION_BPS}.
    error ReputationOutOfRange(uint16 bps);

    constructor(IERC20 token_, address platform_) {
        require(address(token_) != address(0), ZeroAddress());
        require(platform_ != address(0), ZeroAddress());
        token = token_;
        platform = platform_;
    }

    // ------------------------------------------------------------------ creator

    /**
     * @notice Creates a Listing owned by the caller and locks `stakeAmount` of tUSD against it.
     * @dev Pulled with `transferFrom`, so the caller approves this contract first. The
     *      stake floor is checked before the pull, so a listing that cannot meet it costs
     *      the caller nothing but gas.
     * @param agentId The ERC-8004 identity registered for this Agent, owned by the caller.
     * @param agentType One of the five Type names; the contract stores it verbatim.
     * @param price Price per call in tUSD base units.
     * @param endpoint The Agent's HTTPS endpoint.
     * @param payTo The wallet x402 pays for a Call. Need not be the creator.
     * @param stakeAmount tUSD to lock, at least {STAKE_MULTIPLE} times `price`.
     * @return listingId The new Listing's id, also its `registry_listing_id` off-chain.
     */
    function list(
        uint256 agentId,
        string calldata agentType,
        uint256 price,
        string calldata endpoint,
        address payTo,
        uint256 stakeAmount
    ) external returns (uint256 listingId) {
        require(price != 0, ZeroPrice());
        require(payTo != address(0), ZeroAddress());
        require(bytes(endpoint).length != 0, EmptyEndpoint());
        uint256 required = price * STAKE_MULTIPLE;
        require(stakeAmount >= required, StakeBelowMinimum(stakeAmount, required));

        listingId = ++_lastListingId;
        Listing storage listing = _listings[listingId];
        listing.creator = msg.sender;
        listing.payTo = payTo;
        listing.agentId = agentId;
        listing.agentType = agentType;
        listing.endpoint = endpoint;
        listing.price = price;
        listing.stake = stakeAmount;

        emit Listed(listingId, msg.sender, agentId, agentType, price, endpoint, payTo, stakeAmount);
        token.safeTransferFrom(msg.sender, address(this), stakeAmount);
    }

    /**
     * @notice Adds `amount` of tUSD to a Listing's stake, clearing the stake pause when the
     *         stake is back at or above the floor (FR-8).
     * @dev Open to any account. The tUSD comes from the caller, so a third party topping up
     *      a Listing is a donation, not an attack, and the Creator keeps every other right.
     */
    function addStake(uint256 listingId, uint256 amount) external {
        Listing storage listing = _mustExist(listingId);
        require(amount != 0, ZeroAmount());

        listing.stake += amount;
        if (listing.pausedByStake && listing.stake >= listing.price * STAKE_MULTIPLE) {
            listing.pausedByStake = false;
            emit Paused(listingId, listing.pausedByCreator, false);
        }

        emit Staked(listingId, msg.sender, amount, listing.stake);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Sets a new price per call, refused when the stake would fall below the floor (FR-9).
    function setPrice(uint256 listingId, uint256 newPrice) external {
        Listing storage listing = _mustCreator(listingId);
        require(newPrice != 0, ZeroPrice());
        uint256 required = newPrice * STAKE_MULTIPLE;
        require(listing.stake >= required, StakeBelowMinimum(listing.stake, required));

        listing.price = newPrice;
        emit PriceSet(listingId, newPrice);
    }

    /// @notice The Creator's pause switch. Independent of the stake pause.
    function setPaused(uint256 listingId, bool paused) external {
        Listing storage listing = _mustCreator(listingId);
        listing.pausedByCreator = paused;
        emit Paused(listingId, paused, listing.pausedByStake);
    }

    // ----------------------------------------------------------------- platform

    /**
     * @notice Pays `amount` of the Listing's stake to `to` for the Call identified by `callRef`.
     * @dev Clamped to the remaining stake rather than reverting, so a settlement tick never
     *      wedges on a Listing that has already been drained; {Slashed} carries the clamped
     *      amount, which is what the settlement row records as `slash_amount`. Reaching zero
     *      sets the stake pause.
     * @param callRef `keccak256(call_id)` (AD-8), so a slash is traceable to one Call.
     * @return slashed The amount actually paid out.
     */
    function slash(uint256 listingId, bytes32 callRef, uint256 amount, address to)
        external
        returns (uint256 slashed)
    {
        require(msg.sender == platform, NotPlatform(msg.sender));
        Listing storage listing = _mustExist(listingId);
        require(to != address(0), ZeroAddress());

        slashed = amount > listing.stake ? listing.stake : amount;
        listing.stake -= slashed;
        if (listing.stake == 0 && !listing.pausedByStake) {
            listing.pausedByStake = true;
            emit Paused(listingId, listing.pausedByCreator, true);
        }

        emit Slashed(listingId, callRef, slashed);
        if (slashed != 0) token.safeTransfer(to, slashed);
    }

    /// @notice Writes the reputation the settlement loop computed, in basis points (AD-9).
    function setReputation(uint256 listingId, uint16 bps) external {
        require(msg.sender == platform, NotPlatform(msg.sender));
        Listing storage listing = _mustExist(listingId);
        require(bps <= MAX_REPUTATION_BPS, ReputationOutOfRange(bps));

        listing.reputationBps = bps;
        emit ReputationSet(listingId, bps);
    }

    // --------------------------------------------------------------------- read

    /// @notice The whole Listing, the single source `refreshListingFromChain` reads (AD-2).
    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _mustExist(listingId);
    }

    /// @notice The id of the most recent Listing; ids run 1..listingCount().
    function listingCount() external view returns (uint256) {
        return _lastListingId;
    }

    /// @notice The stake a Listing must hold at its current price.
    function requiredStake(uint256 listingId) external view returns (uint256) {
        return _mustExist(listingId).price * STAKE_MULTIPLE;
    }

    // ------------------------------------------------------------------ internal

    function _mustExist(uint256 listingId) private view returns (Listing storage listing) {
        listing = _listings[listingId];
        require(listing.creator != address(0), UnknownListing(listingId));
    }

    function _mustCreator(uint256 listingId) private view returns (Listing storage listing) {
        listing = _mustExist(listingId);
        require(msg.sender == listing.creator, NotCreator(listingId, msg.sender));
    }
}
